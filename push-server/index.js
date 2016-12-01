let logger = require('winston-proxy')('Index');
let cluster = require('cluster');
let net = require('net');

let proxy = {};
try {
    proxy = require(process.cwd() + "/config-proxy");
} catch (ex) {
    logger.warn('config-proxy exception: ' + ex);
}
proxy.instances = proxy.instances || 0;


let api = {};
try {
    api = require(process.cwd() + "/config-api");
} catch (ex) {
    logger.warn('config-api exception: ' + ex);
}
api.instances = api.instances || 0;


let admin = {instances: 0};
try {
    admin = require(process.cwd() + "/config-admin");
    admin.instances = 1;
    admin.port = admin.port || 12001;
} catch (ex) {
    logger.warn('config-admin exception: ' + ex);
}

if (cluster.isMaster) {
    let totalWorker = proxy.instances + api.instances + admin.instances;
    require('fs').writeFile(process.cwd() + '/num_processes', totalWorker, (err) => {
        if (err) {
            logger.error("fail to write num of processes");
        }
    });
    logger.info('total worker: ' + totalWorker);
    let spawn = (env, workerPool) => {
        let worker = cluster.fork(env);
        worker.on('exit', (code, signal) => {
            logger.error('worker(%s) exit, code:%s, signal:%s', worker.id, code, signal);
            let newWorker = spawn(env, workerPool);
            if (workerPool) {
                let index = workerPool.indexOf(worker);
                workerPool[index] = newWorker;
                logger.debug('respwan new worker(%s), workers: %s, pid: %s', newWorker.id,
                    workerPool.map((worker) => {
                        return worker.id
                    }),
                    workerPool.map((worker) => {
                        return worker.process.pid;
                    }));
            }
        });
        return worker;
    };

    let ipHash = (ip, workerLength) => {
        let s = '';
        for (let i = 0; i < ip.length; i++) {
            if (!isNaN(ip[i])) {
                s += ip[i];
            }
        }
        return Number(s) % workerLength;
    };

    let lastIndexNumber = 0;

    let rr = (workerLength) => {
        if (++lastIndexNumber == workerLength) lastIndexNumber = 0;
        return lastIndexNumber;
    };

    if (proxy.instances > 0) {
        let proxy_workers = [];
        for (let i = 0; i < proxy.instances; i++) {
            proxy_workers.push(spawn({processType: 'proxy'}, proxy_workers));
        }
        if (proxy.http_port) {
            net.createServer({pauseOnConnect: true}, (socket) => {
                let worker = proxy_workers[ipHash(socket.remoteAddress, proxy.instances)];
                worker.send('sticky:connection', socket);
            }).listen(proxy.http_port).on('listening', () => {
                logger.debug('proxy listening on ' + proxy.http_port)
            });
        }
        if (proxy.https_port && proxy.https_key && proxy.https_cert) {
            net.createServer({pauseOnConnect: true}, (socket) => {
                let worker = proxy_workers[ipHash(socket.remoteAddress, proxy.instances)];
                worker.send('sticky:connection', socket);
            }).listen(proxy.https_port);
        }
    }
    if (api.instances > 0) {
        let api_workers = [];
        for (let i = 0; i < api.instances; i++) {
            api_workers.push(spawn({processType: 'api'}, api_workers));
        }
        if (api.port) {
            net.createServer({pauseOnConnect: true}, (socket) => {
                let worker = api_workers[rr(api.instances)];
                worker.send('sticky:connection', socket);
            }).listen(api.port);
        }
    }
    if (admin.instances > 0) {
        spawn({processType: 'admin'})
    }
} else {
    if (process.env.processType) {
        let servers = {};
        if (process.env.processType == 'proxy') {
            let IoServer = require('socket.io');
            let io = new IoServer({
                pingTimeout: proxy.pingTimeout,
                pingInterval: proxy.pingInterval,
                transports: ['websocket', 'polling']
            });
            if (proxy.http_port) {
                let httpServer = require('http').createServer();
                io.attach(httpServer);
                io.hs = httpServer;
                servers[proxy.http_port] = httpServer;
            }
            if (proxy.https_port && proxy.https_key && proxy.https_cert) {
                let fs = require('fs');
                try {
                    let https_key = fs.readFileSync(proxy.https_key);
                    let https_cert = fs.readFileSync(proxy.https_cert);
                    let httpsServer = require('https').createServer({key: https_key, cert: https_cert});
                    io.attach(httpsServer);
                    io.hss = httpsServer;
                    servers[proxy.https_port] = httpsServer;
                } catch (e) {
                    logger.error('error happened when start https on proxy.');
                    process.exit(-1);
                }

            }
            require('./lib/proxy')(io, proxy);
        } else if (process.env.processType == 'api') {
            let httpServer = require('http').createServer();
            servers[api.port] = httpServer;
            require('./lib/api')(httpServer, api);
        } else if (process.env.processType == 'admin') {
            require('./lib/admin')(admin);
        }
        if (Object.keys(servers).length > 0) {
            process.on('message', (msg, socket) => {
                if (msg !== 'sticky:connection') {
                    return;
                }
                logger.debug('connection on worker: ', cluster.worker.id, socket.remoteAddress);
                servers[socket.localPort].emit('connection', socket);
                socket.resume();
            });
        }
    }

}
