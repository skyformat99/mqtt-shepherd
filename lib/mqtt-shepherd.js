/*jslint node: true */
'use strict';

var fs = require('fs'),
    path = require('path'),
    util = require('util'),
    crypto = require('crypto'),
    EventEmitter = require('events');

var Q = require('q'),
    _ = require('busyman'),
    Areq = require('areq'),
    network = require('network'),
    debug = require('debug');

var init = require('./init'),
    mutils = require('./components/mutils'),
    msghdlr = require('./components/msghandler'),
    Mqdb = require('./components/mqdb'),
    config = require('./config.js');

// set up debuggers
var SHP = debug('shp'),
    BRK = debug('brk'),
    AUTH = debug('auth'),
    MC = debug('mc'),
    ERR = debug('shp:err'),
    APP = debug('app');

function MShepherd(name, settings) {
    var self = this,
        permitJoinCountdown,
        transId = 0;

    EventEmitter.call(this);

    if (!_.isString(name)) {
        settings = name;
        name = null;
    }

    settings = settings || {};

    if (!_.isObject(settings))
        throw new TypeError('settings should be an object if gieven.');

    /***************************************************/
    /*** Prepare Shepherd Settings                   ***/
    /***************************************************/
    this.clientId = name || config.shepherdName;
    this.brokerSettings = settings.brokerSettings || config.brokerSettings;
    this.defaultAccount = settings.account || config.defaultAccount;
    this.clientConnOptions = settings.clientConnOptions || config.clientConnOptions;
    this.reqTimeout = settings.reqTimeout || config.reqTimeout;

    /***************************************************/
    /*** Protected Memebers                          ***/
    /***************************************************/
    this._dbPath = settings.defaultDbPath;

    if (!this._dbPath) {    // use default
        this._dbPath = config.defaultDbPath;
        // create default db folder if not there
        try {
            fs.statSync(config.defaultdBFolder);
        } catch (e) {
            fs.mkdirSync(config.defaultdBFolder);
        }
    }

    this._mqdb = new Mqdb(this._dbPath);
    this._nodebox = {};         // { clientId: node } box that holds the registered mqtt-nodes

    this._joinable = false;
    this._enabled = false;
    this._permitJoinTime = 0;
    this._startTime = 0;

    this._net = {
        intf: '',
        ip: '',
        mac: '',
        routerIp: ''
    };

    this._channels = {
        'register/#': 0,
        'deregister/#': 0,
        'notify/#': 1,
        'update/#': 1,
        'response/#': 1,
        'ping/#': 0,
        'lwt/#': 0,
        'request/#': 0,
        'announce/#': 0
    };

    this._areq = new Areq(this, config.reqTimeout);

    /***************************************************/
    /*** Public Members                              ***/
    /***************************************************/
    this.mBroker = null;
    this.mClient = null;

    this.authPolicy = {
        // Override at will.
        authenticate: null,     // don't provide default implement, use defaultAccount scheme
        // Override at will.
        authorizePublish: function (client, topic, payload, cb) {
            var authorized = true;
            cb(null, authorized);
        },
        // Override at will.
        authorizeSubscribe: function (client, topic, cb) {
            var authorized = true;
            cb(null, authorized);
        },
        // Default: authorize any packet for any client. Override at will
        authorizeForward: function (client, packet, cb) {
            var authorized = true;
            cb(null, authorized);
        }
    };

    // Overide at will
    this.encrypt = function (msgStr, clientId, callback) {
        callback(null, msgStr);
    };

    // Overide at will
    this.decrypt = function (msgBuf, clientId, callback) {
        callback(null, msgBuf);
    };

    this.nextTransId = function () {
        if (transId > 255)
            transId = 0;
        return transId++;
    };

    this.permitJoin = function (time) {
        var self = this;

        time = time || 0;
        this._permitJoinTime = Math.floor(time);

        if (!time) { 
            this._joinable = false;
            this._permitJoinTime = 0;

            this.emit('permitJoining', this._permitJoinTime);
            if (permitJoinCountdown) {
                clearInterval(permitJoinCountdown);
                permitJoinCountdown = null;
            }
            return this;
        } else {
            this._joinable = true;
            this.emit('permitJoining', this._permitJoinTime);
        }

        permitJoinCountdown = setInterval(function () {
            self._permitJoinTime -= 1;
            self.emit('permitJoining', self._permitJoinTime);

            if (self._permitJoinTime === 0) {
                self._joinable = false;
                clearInterval(permitJoinCountdown);
                permitJoinCountdown = null;
            }
        }, 1000);

        return this;
    };

    /***************************************************/
    /*** Event Handlers (Ind Event Bridges)          ***/
    /***************************************************/
    this.on('_ready', function () {
        self._startTime = Math.floor(Date.now()/1000);
        self.emit('ready');
    });

    this.on('ind:incoming', function (qnode) {
        self.emit('ind', {
            type: 'devIncoming',
            qnode: qnode,
            data: undefined
        });
    });

    this.on('ind:leaving', function (clientId, macAddr) {
        self.emit('ind', {
            type: 'devLeaving',
            qnode: clientId,
            data: macAddr
        });
    });

    this.on('ind:updated', function (qnode, diff) {
        self.emit('ind', {
            type: 'devUpdate',
            qnode: qnode,
            data: diff
        });
    });

    this.on('ind:notified', function (qnode, msg) {
        var notifData = {
            oid: msg.oid,
            iid: msg.iid,
            rid: msg.rid,
            data: msg.data
        };

        self.emit('ind', {
            type: 'devNotify',
            qnode: qnode,
            data: notifData
        });
    });

    this.on('ind:changed', function (ind) {
        var qnode = self.find(ind.clientId),
            notifData = {
                oid: ind.oid,
                iid: ind.iid,
                rid: ind.rid,
                data: ind.data
            };

        if (!qnode)
            return;

        self.emit('ind', {
            type: 'devChange',
            qnode: qnode,
            data: notifData
        });
    });

    this.on('ind:status', function (qnode, status) {
        self.emit('ind', {
            type: 'devStatus',
            qnode: qnode,
            data: status
        });
    });
}

util.inherits(MShepherd, EventEmitter);

/*************************************************************************************************/
/*** MShepherd Major Functions                                                                 ***/
/*************************************************************************************************/
MShepherd.prototype.find = function (clientId) {
    return this._nodebox[clientId];
};

MShepherd.prototype.findByMacAddr = function (macAddr) {
    return _.filter(this._nodebox, function (qnode) {
        return qnode.mac === macAddr;
    });
};  // return []

MShepherd.prototype.updateNetInfo = function (callback) {
    var shepherd = this,
        deferred = Q.defer();

    network.get_active_interface(function(err, info) {
        if (err) {
            deferred.reject(err);
        } else {
            shepherd._net.intf = info.name;
            shepherd._net.ip = info.ip_address;
            shepherd._net.mac = info.mac_address;
            shepherd._net.routerIp = info.gateway_ip;
            deferred.resolve(_.cloneDeep(shepherd._net));
        }
    });

    return deferred.promise.nodeify(callback);
};

MShepherd.prototype.start = function (callback) {
    var shepherd = this,
        deferred = Q.defer();

    init.setupShepherd(this)
        .timeout(config.initTimeout || 8000, 'Broker init timeout.')
        .fail(function (err) {
            ERR(err);
            deferred.reject(err);
        }).done(function () {
            shepherd._enabled = true;   // 6. testings are done, shepherd is enabled 
            shepherd.emit('_ready');    // 7. if all done, shepherd fires '_ready' event for inner use
            deferred.resolve();
        });

    return deferred.promise.nodeify(callback);
};

MShepherd.prototype.stop = function (callback) {
    var self = this,
        deferred = Q.defer(),
        mClient = this.mClient;

    if (!this._enabled) {
        deferred.resolve();
    } else {
        this.permitJoin(0);
        this._enabled = false;
        // close mClient, force = true, close immediately
        mClient.end(true, function () {    
            self.mClient = null;
            deferred.resolve();
        });
    }

    return deferred.promise.nodeify(callback);
};

MShepherd.prototype.reset = function (mode, callback) {
    var self = this,
        deferred = Q.defer();

    if (!_.isBoolean(mode)) {
        callback = mode;
        mode = false;
    }

    if (mode === true) {
        // remove file
        try {
            fs.unlinkSync(this._dbPath);
        } catch (e) {
            console.log(e);
        }
        // clear storage
        this._mqdb = null;
        this._nodebox = null;
        this._mqdb = new Mqdb(this._dbPath);
        this._nodebox = {};
    }

    this.stop().then(function () {
        return self.start();
    }).done(function () {
        deferred.resolve();
    }, function (err) {
        ERR(err);
        deferred.reject(err);
    });

    return deferred.promise.nodeify(callback);
};

MShepherd.prototype.deregisterNode = function (clientId, callback) {
    var self = this,
        deferred = Q.defer(),
        qnode = this.find(clientId),
        macAddr;

    if (!qnode) {
        this._responseSender('deregister', clientId, { status: mutils.rspCodeNum('NotFound') }).done();
        deferred.resolve(clientId);
    } else {
        macAddr = qnode.mac;
        qnode._setStatus('offline');
        qnode.disableLifeChecker();
        qnode.dbRemove().done(function () {
            qnode._registered = false;
            qnode.so = null;
            delete qnode.so;
            self._nodebox[clientId] = null;
            delete self._nodebox[clientId];

            self._responseSender('deregister', clientId, { status: mutils.rspCodeNum('Deleted') }).done(function () {
                self.emit('deregistered', clientId);
                self.emit('ind:leaving', clientId, macAddr);
            });
            deferred.resolve(clientId);
        }, function (err) {
            ERR(err);
            deferred.reject(err);
        });
    }

    return deferred.promise.nodeify(callback);
};

MShepherd.prototype.remove = function (clientId, callback) {
    return this.deregisterNode(clientId, callback);
};

MShepherd.prototype.announce = function (msg, callback) {
    var self = this,
        deferred = Q.defer();

    process.nextTick(function () {
        self.mClient.publish('announce', msg, { qos: 0, retain: false }, function () {
            deferred.resolve();
        });
    });

    return deferred.promise.nodeify(callback);
};

// shepherd -> pheripheral
MShepherd.prototype._responseSender = function (intf, clientId, rspObj, callback) {
    var self = this,
        deferred = Q.defer(),
        topic = intf + '/response/' + clientId,
        msg = JSON.stringify(rspObj);           // rspObj won't be changed if it is a string

    if (!this._enabled) {
        deferred.reject(new Error('Shepherd is not ready, cannot send response.'));
    } else {
        this.encrypt(msg, clientId, function (err, encrypted) {
            if (err) {
                 deferred.reject(err);
            } else {
                process.nextTick(function () {
                    SHP('Send response with topic: ' + topic);
                    self.mClient.publish(topic, encrypted, { qos: 1, retain: false }, function () {
                        deferred.resolve();
                    });
                });
            }
        });
    }

    return deferred.promise.nodeify(callback);
};

// shepherd -> pheripheral
MShepherd.prototype._requestSender = function (cmdId, clientId, reqObj, callback) {
    var self = this,
        deferred = Q.defer(),
        areq = this._areq,
        qnode = this.find(clientId),
        topic = 'request/' + clientId,
        cmdIdString = mutils.cmdKey(cmdId),
        evt,
        msg;

    cmdIdString = cmdIdString ? cmdIdString : cmdId;

    if (arguments.length < 2) {
        deferred.reject(new Error('Bad arguments.'));
        return deferred.promise.nodeify(callback);
    } else if (!qnode) {
        deferred.reject(new Error('No such node.'));
        return deferred.promise.nodeify(callback);
    } else if (qnode.status === 'offline') {
        deferred.reject(new Error('Client offline, clientId: ' + qnode.clientId));
        return deferred.promise.nodeify(callback);
    }

    // convert cmdId to number, get transId and stringify request object in this method
    if (reqObj)
        reqObj = mutils.turnReqObjOfIds(reqObj);

    reqObj.cmdId = _.isUndefined(mutils.cmdNum(cmdId)) ? cmdId : mutils.cmdNum(cmdId); // 255: unknown cmd

    if (!this._enabled) {
        deferred.reject(new Error('Shepherd is not ready, cannot send request.'));
    } else if (reqObj.cmdId === 255) {
        deferred.reject(new Error('Unable to send the unknown command.'));
    } else {
        reqObj.transId = this.nextTransId();
        evt = clientId + ':' + cmdIdString + ':' + reqObj.transId;  // 'foo_id:read:101'

        while (areq.isEventPending(evt)) {
            reqObj.transId = this.nextTransId();
            evt = clientId + ':' + cmdIdString + ':' + reqObj.transId;
        }

        msg = JSON.stringify(reqObj);

        self.encrypt(msg, clientId, function (err, encrypted) {
            if (err) {
                 deferred.reject(err);
            } else {
                areq.register(evt, deferred, function (rsp) {
                    qnode._setStatus('online');

                    if (mutils.isGoodResponse(rsp.status))
                        areq.resolve(evt, rsp);
                    else
                        areq.reject(evt, new Error('Bad response: ' + rsp.status));
                });

                process.nextTick(function () {
                    SHP('Send request with topic: ' + topic);
                    self.mClient.publish(topic, encrypted, { qos: 1, retain: false });
                });
            }
        });
    }

    return deferred.promise.nodeify(callback);
};

/*************************************************************************************************/
/*** Request to Remote APIs                                                                    ***/
/*************************************************************************************************/
MShepherd.prototype.readReq = function (clientId, reqObj, callback) {
    return this._requestSender('read', clientId, reqObj, callback);
};

MShepherd.prototype.writeReq = function (clientId, reqObj, callback) {
    return this._requestSender('write', clientId, reqObj, callback);
};

MShepherd.prototype.writeAttrsReq = function (clientId, reqObj, callback) {
    return this._requestSender('writeAttrs', clientId, reqObj, callback);
};

MShepherd.prototype.discoverReq = function (clientId, reqObj, callback) {
    return this._requestSender('discover', clientId, reqObj, callback);
};

MShepherd.prototype.executeReq = function (clientId, reqObj, callback) {
    return this._requestSender('execute', clientId, reqObj, callback);
};

MShepherd.prototype.observeReq = function (clientId, reqObj, callback) {
    return this._requestSender('observe', clientId, reqObj, callback);
};

MShepherd.prototype.pingReq = function (clientId, callback) {
    return this.readReq(clientId, { oid: 'device', iid: 0, rid: 'model' }, callback);
};

/*************************************************************************************************/
/*** Server Information                                                                        ***/
/*************************************************************************************************/
MShepherd.prototype.info = function (callback) {
    return {
        name: this.clientId,
        enabled: this._enabled,
        net: _.cloneDeep(this._net),
        devNum: _.size(this._nodebox),
        startTime: this._startTime,
        joinTimeLeft: this._permitJoinTime
    };
};

MShepherd.prototype.listDevices = function (cIds) {
    var self = this,
        foundNodes = [];

    if (!cIds) {                    // list all
        _.forEach(this._nodebox, function (qnode, clientId) {
            var rec = qnode.dump();
            delete rec.so;
            rec.status = qnode.status;
            foundNodes.push(rec);
        });
    } else if (_.isArray(cIds)) {   // list according to cIds
        _.forEach(cIds, function (cid) {
            var rec,
                found = self.find(cid);

            if (found)  {
                rec = found.dump();
                delete rec.so;
                rec.status = found.status;

                foundNodes.push(rec);
            } else {
                foundNodes.push(null);
            }
        });
    }

    return foundNodes;
};

MShepherd.prototype.devListMaintain = function (qnode, callback) {
    var deferred = Q.defer(),
        nodes,
        nodeIds = [],
        maintainNodes = [];

    if (_.isFunction(qnode)) {
        callback = qnode;
        qnode = undefined;
    }

    if (_.isArray(qnode))
        nodes = qnode;
    else if (qnode)
        nodes = [ qnode ];
    else
        nodes = this._nodebox;

    _.forEach(nodes, function (qn) {
        nodeIds.push(qn.clientId);
        maintainNodes.push(qn.maintain());
    });

    Q.allSettled(maintainNodes).done(function (resArr) {
        var results = [];
        _.forEach(resArr, function (r, i) {
            results.push({
                clientId: nodeIds[i],
                result: r.state === 'fulfilled' ? true : false
            });
        });
        deferred.resolve(results);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise.nodeify(callback);
};

MShepherd.prototype.maintain = function (cIds, callback) {
    var self = this,
        deferred = Q.defer(),
        nodes = [],
        maintainNodes = [];

    if (_.isFunction(cIds)) {
        callback = cIds;
        cIds = [];

        _.forEach(this._nodebox, function (n ,cid) {
            nodes.push(n);
            cIds.push(cid);
        });
    } else if (_.isString(cIds)) {
        nodes.push(this.find(cIds));
        cIds = [ cIds ];
    } else if (_.isArray(cIds)) {
        _.forEach(cIds, function (cId) {
            nodes.push(self.find(cId));
        });
    }

    _.forEach(nodes, function (qn) {
        maintainNodes.push(qn.maintain());
    });

    Q.allSettled(maintainNodes).done(function (resArr) {
        var results = [];
        _.forEach(resArr, function (r, i) {
            results.push({
                clientId: cIds[i],
                result: (r.state === 'fulfilled') ? true : false
            });
        });
        deferred.resolve(results);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise.nodeify(callback);
};

// MShepherd.prototype.sleepyDevPacketPend = function () {};

module.exports = MShepherd;