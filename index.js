#!/usr/bin/env node

const events = require('events');
const {EventEmitter} = events;
const path = require('path');
const fs = require('fs');
const http = require('http');
const querystring = require('querystring');
const crypto = require('crypto');
const repl = require('repl');

const mkdirp = require('mkdirp');
const express = require('express');
const bodyParser = require('body-parser');
const bodyParserJson = bodyParser.json();
const request = require('request');
const ws = require('ws');
const writeFileAtomic = require('write-file-atomic');
const replHistory = require('repl.history');
const bigint = require('big-integer');
const base58 = require('bs58');
const eccrypto = require('eccrypto-sync');

const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const BLOCK_VERSION = '0.0.1';
const DEFAULTS = {
  host: '0.0.0.0',
  port: 6777,
  dataDirectory: path.join(__dirname, 'data'),
};
const MESSAGE_TTL = 10;
const UNDO_HEIGHT = 10;
const CHARGE_SETTLE_BLOCKS = 100;
const HASH_WORK_TIME = 20;
const MESSAGES_PER_BLOCK_MAX = 10000;
const MIN_DIFFICULTY = 1000;
const TARGET_BLOCKS = 10;
const TARGET_TIME = 10 * 60 * 1000;
const TARGET_SWAY_MAX = 2;
const TARGET_SWAY_MIN = 0.5;
const MIN_NUM_LIVE_PEERS = 10;
const CRD = 'CRD';
const COINBASE_QUANTITY = 100;
const NULL_PRIVATE_KEY = (() => {
  const result = Buffer.alloc(32);
  result[0] = 0xFF;
  return result;
})();
const NULL_PUBLIC_KEY = eccrypto.getPublic(NULL_PRIVATE_KEY);
const DEFAULT_DB = {
  balances: {},
  messageHashes: [],
  minters: {
    [CRD]: null,
  },
  prices: {
    CRD: Infinity,
  },
};
const DEFAULT_MEMPOOL = {
  blocks: [],
  messages: [],
};
const maxTarget = bigint('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);
const _getDifficultyTarget = difficulty => maxTarget
  .divide(bigint(Math.round(difficulty)));
const _getHashDifficulty = hash => bigint(hash, 16)
  .divide(maxTarget)
  .valueOf();
const _checkHashMeetsTarget = (hash, target) => bigint(hash, 16).leq(target);
const initialDifficulty = 1e5;
const initialTarget = _getDifficultyTarget(initialDifficulty);
const zeroHash = bigint(0).toString(16);
const connectionsSymbol = Symbol();

class Block {
  constructor(hash, prevHash, height, difficulty, version, timestamp, messages, nonce) {
    this.hash = hash;
    this.prevHash = prevHash;
    this.height = height;
    this.difficulty = difficulty;
    this.version = version;
    this.timestamp = timestamp;
    this.messages = messages;
    this.nonce = nonce;
  }

  static from(o) {
    const {hash, prevHash, height, difficulty, version, timestamp, messages, nonce} = o;
    return new Block(hash, prevHash, height, difficulty, version, timestamp, messages.map(message => Message.from(message)), nonce);
  }

  equals(block) {
    return this.hash === block.hash;
  }

  getHash() {
    const {prevHash, height, difficulty, version, timestamp, messages, nonce} = this;
    const messagesJson = messages
      .map(message => JSON.stringify(message))
      .join('\n');

    const uint64Array = new Uint32Array(1);
    const hashRoot = (() => {
      const hasher = crypto.createHash('sha256');
      hasher.update(prevHash);
      hasher.update(':');
      uint64Array[0] = height;
      hasher.update(uint64Array);
      hasher.update(':');
      uint64Array[0] = difficulty;
      hasher.update(uint64Array);
      hasher.update(':');
      hasher.update(version);
      hasher.update(':');
      uint64Array[0] = timestamp;
      hasher.update(uint64Array);
      hasher.update(':');
      hasher.update(messagesJson);
      hasher.update(':');
      return hasher.digest();
    })();

    const hasher = crypto.createHash('sha256');
    hasher.update(hashRoot);
    uint64Array[0] = nonce;
    hasher.update(uint64Array);
    return hasher.digest('hex');
  }

  verify(db, blocks, mempool = null) {
    const _checkHash = () => this.getHash() === this.hash;
    const _checkPrevHash = () => {
      const prevBlockHash = (blocks.length > 0) ? blocks[blocks.length - 1].hash : zeroHash;
      return this.prevHash === prevBlockHash;
    };
    const _checkHeight = () => {
      const nextBlockHeight = ((blocks.length > 0) ? blocks[blocks.length - 1].height : 0) + 1;
      return this.height === nextBlockHeight;
    };
    const _checkTimestamp = () => this.timestamp >= _getNextBlockMinTimestamp(blocks);
    const _checkDifficultyClaim = () => _checkHashMeetsTarget(this.hash, _getDifficultyTarget(this.difficulty));
    const _checkSufficientDifficulty = () => this.difficulty >= (Math.max(_getNextBlockBaseDifficulty(blocks) - _getMessagesDifficulty(this.messages), MIN_DIFFICULTY));
    const _checkMessagesCount = () => this.messages.length <= MESSAGES_PER_BLOCK_MAX;
    const _verifyMessages = () => {
      for (let i = 0; i < this.messages.length; i++) {
        const message = this.messages[i];
        const confirmingMessages = this.messages.slice();
        confirmingMessages.splice(i, 1);
        const error = message.verify(db, blocks, mempool, confirmingMessages);
        if (error) {
          return error;
        }
      }
      return null;
    };

    if (!_checkHash()) {
      return {
        status: 400,
        error: 'invalid hash',
      };
    } else if (!_checkPrevHash()) {
      return {
        status: 400,
        error: 'invalid previous hash',
        soft: true,
      };
    } else if (!_checkHeight()) {
      return {
        status: 400,
        error: 'invalid height',
      };
    } else if (!_checkTimestamp()) {
      return {
        status: 400,
        error: 'invalid timestamp',
      };
    } else if (!_checkDifficultyClaim()) {
      return {
        status: 400,
        error: 'invalid difficulty claim',
      };
    } else if (!_checkMessagesCount()) {
      return {
        status: 400,
        error: 'too many messages',
      };
    } else if (!_checkSufficientDifficulty()) {
      return {
        status: 400,
        error: 'insufficient difficulty',
      };
    } else {
      const error = _verifyMessages();

      if (!error) {
        return null;
      } else {
        return error;
      }
    }
  }
}

class Message {
  constructor(payload, hash, signature) {
    this.payload = payload;
    this.hash = hash;
    this.signature = signature;
  }

  static from(o) {
    const {payload, hash, signature} = o;
    return new Message(payload, hash, signature);
  }

  equals(message) {
    return this.hash === message.hash;
  }

  verify(db, blocks, mempool = null, confirmingMessages = []) {
    const {payload, hash, signature} = this;
    const payloadHash = crypto.createHash('sha256').update(payload).digest();
    const payloadHashHex = payloadHash.toString('hex');

    if (payloadHashHex === hash) {
      const payloadJson = JSON.parse(payload);
      const {startHeight} = payloadJson;
      const endHeight = startHeight + MESSAGE_TTL;
      const nextHeight = ((blocks.length > 0) ? blocks[blocks.length - 1].height : 0) + 1;

      if (nextHeight >= startHeight && nextHeight < endHeight) {
        if (!db.messageHashes.some(hashes => hashes.includes(hash))) {
          const {type} = payloadJson;

          switch (type) {
            case 'coinbase': {
              const {asset, quantity, address} = payloadJson;
              const publicKeyBuffer = NULL_PUBLIC_KEY;
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (asset === CRD && quantity === COINBASE_QUANTITY) {
                  if (confirmingMessages.filter(confirmingMessage => {
                    const payloadJson = JSON.parse(confirmingMessage.payload);
                    const {type} = payloadJson;
                    return type === 'coinbase';
                  }).length === 0) {
                    return null;
                  } else {
                    return {
                      status: 400,
                      error: 'multiple coinbases',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid coinbase',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }

              break;
            }
            case 'send': {
              const {asset, quantity, srcAddress, publicKey} = payloadJson;
              const publicKeyBuffer = new Buffer(publicKey, 'base64');
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer) && _getAddressFromPublicKey(publicKeyBuffer) === srcAddress) {
                if (_isValidAsset(asset)) {
                  if (quantity > 0 && Math.floor(quantity) === quantity && (!_isMintAsset(asset) || quantity === 1)) {
                    const balance = !mempool ? _getConfirmedBalance(db, confirmingMessages, srcAddress, asset) : _getUnconfirmedBalance(db, mempool, confirmingMessages, srcAddress, asset);

                    if (balance >= quantity) {
                      return null;
                    } else {
                      return {
                        status: 402,
                        error: 'insufficient funds',
                      };
                    }
                  } else {
                    return {
                      status: 400,
                      error: 'invalid quantity',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'minter': {
              const {asset, publicKey} = payloadJson;
              const publicKeyBuffer = new Buffer(publicKey, 'base64');
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBaseAsset(asset)) {
                  const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, asset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, asset);

                  if (minter === undefined) {
                    return null;
                  } else {
                    return {
                      status: 400,
                      stack: 'asset already has minter',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    stack: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'mint': {
              const {asset, quantity, publicKey} = payloadJson;
              const publicKeyBuffer = new Buffer(publicKey, 'base64');
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBasicAsset(asset)) {
                  if (quantity > 0 && Math.floor(quantity) === quantity) {
                    const address = _getAddressFromPublicKey(publicKeyBuffer);
                    const baseAsset = _getBaseAsset(asset);
                    const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, baseAsset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, baseAsset);

                    if (minter === address) {
                      return null;
                    } else {
                      const price = !mempool ? _getConfirmedPrice(db, confirmingMessages, baseAsset) : _getUnconfirmedPrice(db, mempool, confirmingMessages, baseAsset);

                      if (price === 0) {
                        return null;
                      } else {
                        return {
                          status: 400,
                          stack: 'address cannot mint this asset',
                        };
                      }
                    }
                  } else {
                    return {
                      status: 400,
                      error: 'invalid quantity',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'get': {
              const {address, asset, quantity} = payloadJson;
              const publicKeyBuffer = NULL_PUBLIC_KEY;
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBasicAsset(asset)) {
                  if (quantity > 0 && Math.floor(quantity) === quantity) {
                    const baseAsset = _getBaseAsset(asset);
                    const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, baseAsset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, baseAsset);

                    if (minter === undefined || minter === address) {
                      return null;
                    } else {
                      const price = !mempool ? _getConfirmedPrice(db, confirmingMessages, baseAsset) : _getUnconfirmedPrice(db, mempool, confirmingMessages, baseAsset);

                      if (price === 0) {
                        return null;
                      } else {
                        return {
                          status: 400,
                          stack: 'address cannot mint this asset',
                        };
                      }
                    }
                  } else {
                    return {
                      status: 400,
                      error: 'invalid quantity',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'burn': {
              const {asset, quantity, publicKey} = payloadJson;
              const publicKeyBuffer = new Buffer(publicKey, 'base64');
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBasicAsset(asset)) {
                  if (quantity > 0 && Math.floor(quantity) === quantity) {
                    const address = _getAddressFromPublicKey(publicKeyBuffer);

                    const _checkFree = () => {
                      const baseAsset = _getBaseAsset(asset);
                      const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, baseAsset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, baseAsset);
                      if (minter === undefined || minter === address) {
                        return null;
                      } else {
                        const price = !mempool ? _getConfirmedPrice(db, confirmingMessages, baseAsset) : _getUnconfirmedPrice(db, mempool, confirmingMessages, baseAsset);

                        if (price === 0) {
                          return null;
                        } else {
                          return {
                            status: 400,
                            stack: 'address cannot burn this asset',
                          };
                        }
                      }
                    };
                    const _checkBalance = () => {
                      const balance = !mempool ? _getConfirmedBalance(db, confirmingMessages, address, asset) : _getUnconfirmedBalance(db, mempool, confirmingMessages, address, asset);

                      if (balance >= quantity) {
                        return null;
                      } else {
                        return {
                          status: 402,
                          error: 'insufficient funds',
                        };
                      }
                    };

                    return _checkFree() || _checkBalance();
                  } else {
                    return {
                      status: 400,
                      error: 'invalid quantity',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'drop': {
              const {address, asset, quantity} = payloadJson;
              const publicKeyBuffer = NULL_PUBLIC_KEY;
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBasicAsset(asset)) {
                  if (quantity > 0 && Math.floor(quantity) === quantity) {

                    const _checkFree = () => {
                      const baseAsset = _getBaseAsset(asset);
                      const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, baseAsset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, baseAsset);
                      if (minter === undefined || minter === address) {
                        return null;
                      } else {
                        const price = !mempool ? _getConfirmedPrice(db, confirmingMessages, baseAsset) : _getUnconfirmedPrice(db, mempool, confirmingMessages, baseAsset);

                        if (price === 0) {
                          return null;
                        } else {
                          return {
                            status: 400,
                            stack: 'address cannot drop this asset',
                          };
                        }
                      }
                    };
                    const _checkBalance = () => {
                      const balance = !mempool ? _getConfirmedBalance(db, confirmingMessages, address, asset) : _getUnconfirmedBalance(db, mempool, confirmingMessages, address, asset);

                      if (balance >= quantity) {
                        return null;
                      } else {
                        return {
                          status: 402,
                          error: 'insufficient funds',
                        };
                      }
                    };

                    return _checkFree() || _checkBalance();
                  } else {
                    return {
                      status: 400,
                      error: 'invalid quantity',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'price': {
              const {asset, price, publicKey} = payloadJson;
              const publicKeyBuffer = new Buffer(publicKey, 'base64');
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBaseAsset(asset)) {
                  const address = _getAddressFromPublicKey(publicKeyBuffer);
                  const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, asset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, asset);

                  if (minter === address) {
                    if (isFinite(price) && price >= 0 && Math.floor(price) === price) {
                      return null;
                    } else {
                      return {
                        status: 400,
                        stack: 'invalid price',
                      };
                    }
                  } else {
                    return {
                      status: 400,
                      stack: 'address is not minter of this asset',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            case 'buy': {
              const {asset, quantity, price, publicKey} = payloadJson;
              const publicKeyBuffer = new Buffer(publicKey, 'base64');
              const signatureBuffer = new Buffer(signature, 'base64');

              if (eccrypto.verify(publicKeyBuffer, payloadHash, signatureBuffer)) {
                if (_isBaseAsset(asset)) {
                  if (quantity > 0 && Math.floor(quantity) === quantity) {
                    if (isFinite(price) && price > 0 && Math.floor(price) === price) {
                      const address = _getAddressFromPublicKey(publicKeyBuffer);
                      const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, asset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, asset);

                      if (minter) {
                        const prices = !mempool ? _getConfirmedPrices(db, confirmingMessages, asset) : _getUnconfirmedPrices(db, mempool, confirmingMessages, asset);

                        if (prices.includes(price)) {
                          const balance = !mempool ? _getConfirmedBalance(db, confirmingMessages, address, CRD) : _getUnconfirmedBalance(db, mempool, confirmingMessages, address, CRD);

                          if (balance >= (quantity * price)) {
                            return null;
                          } else {
                            return {
                              status: 400,
                              stack: 'insufficient funds',
                            };
                          }
                        } else {
                          return {
                            status: 400,
                            stack: 'incorrect declared price',
                          };
                        }
                      } else {
                        return {
                          status: 400,
                          stack: 'address is not minter of this asset',
                        };
                      }
                    } else {
                      return {
                        status: 400,
                        stack: 'invalid price',
                      };
                    }
                  } else {
                    return {
                      status: 400,
                      stack: 'invalid quantity',
                    };
                  }
                } else {
                  return {
                    status: 400,
                    error: 'invalid asset',
                  };
                }
              } else {
                return {
                  status: 400,
                  error: 'invalid signature',
                };
              }
            }
            default: {
              return {
                status: 400,
                error: 'unknown message type',
              };
            }
          }
        } else {
          return {
            status: 400,
            error: 'replay detected',
            soft: true,
          };
        }
      } else {
        return {
          status: 400,
          error: 'ttl expired',
        };
      }
    } else {
      return {
        status: 400,
        error: 'invalid hash',
      };
    }
  }
}
class Peer {
  constructor(url) {
    this.url = url;

    this._connection = null;
    this._enabled = null;
    this._reconnectTimeout = null;
    this._redownloadInterval = null;
  }

  equals(peer) {
    return this.url === peer.url;
  }

  isEnabled() {
    return this._enabled;
  }

  enable(c) {
    this._enabled = true;

    const _listen = () => {
      const _recurse = () => {
        const connection = new ws(this.url.replace(/^http/, 'ws') + '/listen');
        connection.on('open', () => {
          connection.on('message', s => {
            const m = JSON.parse(s);
            const {type} = m;

            switch (type) {
              case 'block': {
                const {block: blockJson} = m;
                const block = Block.from(blockJson);
                const error = c.addBlock(block);
                if (error && !error.soft) {
                  console.warn('add remote block error:', error);
                }
                break;
              }
              case 'message': {
                const {message: messgeJson} = m;
                const message = Message.from(messgeJson);
                const error = c.submitMessage(message);
                if (error && !error.soft) {
                  console.warn('add remote message error:', error);
                }
                break;
              }
              case 'peer': {
                const {peer} = m;
                c.addPeer(peer);
                break;
              }
              default: {
                console.warn('unknown message type:', msg);
                break;
              }
            }
          });
          connection.on('close', () => {
            this._connection = null;

            if (this._enabled) {
              _retry();
            }
          });
        });
        connection.on('error', err => {
          // console.warn(err);

          this._connection = null;

          if (this._enabled) {
            _retry();
          }
        });

        this._connection = connection;
      };
      const _retry = () => {
        this._reconnectTimeout = setTimeout(() => {
          this._reconnectTimeout = null;

          _recurse();
        }, 1000);
      };

      _recurse();
    };
    const _download = () => {
      const _recurse = () => {
        const _requestBlocks = ({startHeight}) => new Promise((accept, reject) => {
          const result = [];

          const _recurse = height => {
            request(this.url + '/blocks/' + height, {
              json: true,
            }, (err, res, body) => {
              if (!err) {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  const block = body;
                  result.push(block);

                  _recurse(height + 1);
                } else if (res.statusCode === 404) {
                  accept(result);
                } else {
                  reject({
                    status: res.statusCode,
                    error: 'invalid status code',
                  });
                }
              } else {
                reject(err);
              }
            });
          };
          _recurse(startHeight);
        });
        const _requestMempool = () => new Promise((accept, reject) => {
          request(this.url + '/mempool', {
            json: true,
          }, (err, res, body) => {
            if (!err) {
              const mempool = body;
              accept(mempool);
            } else {
              reject(err);
            }
          });
        });
        const _requestPeers = () => new Promise((accept, reject) => {
          request(this.url + '/peers', {
            json: true,
          }, (err, res, body) => {
            if (!err) {
              const peers = body;
              accept(peers);
            } else {
              reject(err);
            }
          });
        });

        const topBlockHeight = (c.blocks.length > 0) ? c.blocks[c.blocks.length - 1].height : 0;
        Promise.all([
          _requestBlocks({
            startHeight: Math.max(topBlockHeight - CHARGE_SETTLE_BLOCKS, 1),
          }),
          _requestMempool(),
          _requestPeers(),
        ])
          .then(([
            remoteBlocks,
            remoteMempool,
            remotePeers,
          ]) => {
            const _addBlocks = () => {
              for (let i = 0; i < remoteBlocks.length; i++) {
                const remoteBlock = Block.from(remoteBlocks[i]);
                const error = c.addBlock(remoteBlock);
                if (error && !error.soft) {
                  console.warn('add remote block error:', error);
                }
              }
            };
            const _addMempool = () => {
              const {blocks: remoteBlocks, messages: remoteMessages} = remoteMempool;

              for (let i = 0; i < remoteBlocks.length; i++) {
                const remoteBlock = Block.from(remoteBlocks[i]);
                const error = c.addBlock(remoteBlock);
                if (error && !error.soft) {
                  console.warn('add remote block error:', error);
                }
              }
              for (let i = 0; i < remoteMessages.length; i++) {
                const remoteMessage = Message.from(remoteMessages[i]);
                const error = c.submitMessage(remoteMessage);
                if (error && !error.soft) {
                  console.warn('add remote message error:', error);
                }
              }
            };
            const _addPeers = () => {
              for (let i = 0; i < remotePeers.length; i++) {
                const url = remotePeers[i];
                c.addPeer(url);
              }
            };

            _addBlocks();
            _addMempool();
            _addPeers();
          })
          .catch(err => {
            console.warn(err);
          });
      };

      this._redownloadInterval = setInterval(() => {
        _recurse();
      }, 30 * 1000);

      _recurse();
    };

    _listen();
    _download();
  }

  disable() {
    this._enabled = false;

    if (this._connection) {
      this._connection.close();
    }
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);

      this._reconnectTimeout = null;
    }
    if (this._redownloadInterval) {
      clearInterval(this._redownloadInterval);

      this._redownloadInterval = null;
    }
  }
}

class Crds extends EventEmitter {
  constructor({
    dataDirectory = DEFAULTS.dataDirectory,
  } = {}) {
    super();

    this.dataDirectory = dataDirectory;

    this.dbs = [];
    this.blocks = [];
    this.mempool = _clone(DEFAULT_MEMPOOL);
    this.peers = [];

    this.saveStateRunning = false;
    this.saveStateCbs = [];
    this.saveState = this.saveState();

    this.savePeersRunning = false;
    this.savePeersCbs = [];
    this.savePeers = this.savePeers();
  }

  submitMessage(message) {
    const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
    return this.addMessage(db, this.blocks, this.mempool, message);
  }

  addMessage(db, blocks, mempool, message) {
    if (mempool.messages.length < MESSAGES_PER_BLOCK_MAX) {
      if (!mempool.messages.some(mempoolMessage => mempoolMessage.equals(message))) {
        const error = message.verify(db, blocks, mempool);

        if (!error) {
          mempool.messages.push(message);

          this.emit('message', message);
        }
        return error;
      } else {
        return null;
      }
    } else {
      return {
        status: 503,
        error: 'mempool full',
      };
    }
  }

  addBlock(block) {
   const _checkBlockExists = (blocks, mempool, block) => {
      const checkBlockIndex = block.height - 1;
      const topBlockHeight = (blocks.length > 0) ? blocks[blocks.length - 1].height : 0;
      const topBlockIndex = topBlockHeight - 1;
      const firstBlockHeight = (blocks.length > 0) ? blocks[0].height : 0;
      const firstBlockIndex = firstBlockHeight - 1;
      const mainChainBlock = (checkBlockIndex <= topBlockIndex) ? blocks[checkBlockIndex - firstBlockIndex] : null;

      if (mainChainBlock && mainChainBlock.hash === block.hash) {
        return true;
      } else {
        return mempool.blocks.some(mempoolBlock => mempoolBlock.hash === block.hash && mempoolBlock.height === block.height);
      }
    };
    const _findBlockAttachPoint = (blocks, mempool, block) => {
      const {prevHash, height} = block;
      const blockIndex = height - 1;
      const topBlockHeight = (blocks.length > 0) ? blocks[blocks.length - 1].height : 0;
      const topBlockIndex = topBlockHeight - 1;

      if ((blockIndex >= Math.max(topBlockIndex - UNDO_HEIGHT, 0)) && (blockIndex <= (topBlockIndex + 1))) {
        const candidateTopMainChainBlockHash = (blocks.length > 0) ? blocks[blocks.length - 1].hash : zeroHash;

        if (blockIndex === (topBlockIndex + 1) && candidateTopMainChainBlockHash === prevHash) {
          return { // valid on main chain
            type: 'mainChain',
          };
        } else {
          const forkedBlock = _getBlockForkOrigin(blocks, mempool, block);

          if (forkedBlock) {
            const extraBlocks = (() => {
              const result = [];
              for (let b = block; b.hash !== forkedBlock.hash; b = mempool.blocks.find(mempoolBlock => mempoolBlock.hash === b.prevHash)) {
                result.unshift(b);
              }
              return result;
            })();

            return { // valid indirect side chain
              type: 'sideChain',
              forkedBlock: forkedBlock,
              sideChainBlocks: blocks.slice(0, forkedBlock.height).concat(extraBlocks),
            };
          } else {
            if (height === 1) {
              return { // valid initial block
                type: 'sideChain',
                forkedBlock: null,
                sideChainBlocks: [block],
              };
            } else {
              return {
                type: 'dangling',
              };
            }
          }
        }
      } else {
        if (blockIndex < Math.max((topBlockIndex - UNDO_HEIGHT), 0)) {
          return {
            type: 'outOfRange',
            direction: -1,
          };
        } else {
          return {
            type: 'outOfRange',
            direction: 1,
          };
        }
      }
    };
    const _getBlockForkOrigin = (blocks, mempool, block) => {
      const _getPreviousMainChainBlock = block => {
        const {prevHash, height} = block;
        const blockIndex = height - 1;
        const previousBlockIndex = blockIndex - 1;

        if ((previousBlockIndex >= 0) && (previousBlockIndex < blocks.length)) {
          const candidateMainChainBlock = blocks[previousBlockIndex];

          if (candidateMainChainBlock.hash === prevHash) {
            return candidateMainChainBlock;
          } else {
            return null;
          }
        } else {
          return null;
        }
      };
      const _getPreviousMempoolBlock = block => {
        const {prevHash} = block;
        return mempool.blocks.find(mempoolBlock => mempoolBlock.hash === prevHash) || null;
      };
      const forkedBlock = (() => {
        let b = block;

        for (;;) {
          const previousMainChainBlock = _getPreviousMainChainBlock(b);

          if (previousMainChainBlock !== null) {
            return previousMainChainBlock;
          } else {
            const previousMempoolBlock = _getPreviousMempoolBlock(b);

            if (previousMempoolBlock !== null) {
              b = previousMempoolBlock;

              continue;
            } else {
              return null;
            }
          }
        }
      })();

      return forkedBlock;
    };
    const _commitMainChainBlock = (db, blocks, mempool, block) => {
      const newDb = _clone(db);

      // update balances
      for (let i = 0; i < block.messages.length; i++) {
        const message = block.messages[i];
        const {payload, hash, signature} = message;
        const payloadJson = JSON.parse(payload);
        const {type} = payloadJson;

        if (type === 'coinbase') {
          const {asset, quantity, address} = payloadJson;

          let addressEntry = newDb.balances[address];
          if (addressEntry === undefined) {
            addressEntry = {};
            newDb.balances[address] = addressEntry;
          }
          let assetEntry = addressEntry[asset];
          if (assetEntry === undefined) {
            assetEntry = 0;
          }
          assetEntry = assetEntry + quantity;
          addressEntry[asset] = assetEntry;
        } else if (type === 'send') {
          const {asset, quantity, srcAddress, dstAddress} = payloadJson;

          let srcAddressEntry = newDb.balances[srcAddress];
          if (srcAddressEntry === undefined) {
            srcAddressEntry = {};
            newDb.balances[srcAddress] = srcAddressEntry;
          }
          let srcAssetEntry = srcAddressEntry[asset];
          if (srcAssetEntry === undefined) {
            srcAssetEntry = 0;
          }
          srcAssetEntry = srcAssetEntry - quantity;
          srcAddressEntry[asset] = srcAssetEntry;

          let dstAddressEntry = newDb.balances[dstAddress];
          if (dstAddressEntry === undefined) {
            dstAddressEntry = {};
            newDb.balances[dstAddress] = dstAddressEntry;
          }
          let dstAssetEntry = dstAddressEntry[asset];
          if (dstAssetEntry === undefined) {
            dstAssetEntry = 0;
          }
          dstAssetEntry = dstAssetEntry + quantity;
          dstAddressEntry[asset] = dstAssetEntry;

          const match = asset.match(/^(.+):mint$/);
          if (match) {
            const baseAsset = match[1];
            newDb.minters[baseAsset] = dstAddress;
          }
        } else if (type === 'price') {
          const {asset, price} = payloadJson;

          newDb.prices[asset] = price;
        } else if (type === 'buy') {
          const {asset, quantity, price, publicKey} = payloadJson;
          const srcAddress = newDb.minters[asset];
          const publicKeyBuffer = new Buffer(publicKey, 'base64');
          const dstAddress = _getAddressFromPublicKey(publicKeyBuffer);

          let srcAddressEntry = newDb.balances[srcAddress];
          if (srcAddressEntry === undefined) {
            srcAddressEntry = {};
            newDb.balances[srcAddress] = srcAddressEntry;
          }
          let srcAddressDstAssetEntry = srcAddressEntry[CRD];
          if (srcAddressDstAssetEntry === undefined) {
            srcAddressDstAssetEntry = 0;
          }
          srcAddressDstAssetEntry = srcAddressDstAssetEntry + (quantity * price);
          srcAddressEntry[CRD] = srcAddressDstAssetEntry;

          let dstAddressEntry = newDb.balances[dstAddress];
          if (dstAddressEntry === undefined) {
            dstAddressEntry = {};
            newDb.balances[dstAddress] = dstAddressEntry;
          }
          let dstAddressSrcAssetEntry = dstAddressEntry[CRD];
          if (dstAddressSrcAssetEntry === undefined) {
            dstAddressSrcAssetEntry = 0;
          }
          dstAddressSrcAssetEntry = dstAddressSrcAssetEntry - (quantity * price);
          dstAddressEntry[CRD] = dstAddressSrcAssetEntry;

          let dstAddressDstAssetEntry = dstAddressEntry[asset];
          if (dstAddressDstAssetEntry === undefined) {
            dstAddressDstAssetEntry = 0;
          }
          dstAddressDstAssetEntry = dstAddressDstAssetEntry + quantity;
          dstAddressEntry[asset] = dstAddressDstAssetEntry;
        } else if (type === 'mint') {
          const {asset, quantity, publicKey} = payloadJson;
          const publicKeyBuffer = new Buffer(publicKey, 'base64');
          const address = _getAddressFromPublicKey(publicKeyBuffer);

          let addressEntry = newDb.balances[address];
          if (addressEntry === undefined) {
            addressEntry = {};
            newDb.balances[address] = addressEntry;
          }
          let assetEntry = addressEntry[asset];
          if (assetEntry === undefined) {
            assetEntry = 0;
          }
          assetEntry = assetEntry + quantity;
          addressEntry[asset] = assetEntry;
        } else if (type === 'get') {
          const {address, asset, quantity} = payloadJson

          let addressEntry = newDb.balances[address];
          if (addressEntry === undefined) {
            addressEntry = {};
            newDb.balances[address] = addressEntry;
          }
          let assetEntry = addressEntry[asset];
          if (assetEntry === undefined) {
            assetEntry = 0;
          }
          assetEntry = assetEntry + quantity;
          addressEntry[asset] = assetEntry;
        } else if (type === 'burn') {
          const {asset, quantity, publicKey} = payloadJson
          const publicKeyBuffer = new Buffer(publicKey, 'base64');
          const address = _getAddressFromPublicKey(publicKeyBuffer);

          let addressEntry = newDb.balances[address];
          if (addressEntry === undefined) {
            addressEntry = {};
            newDb.balances[address] = addressEntry;
          }
          let assetEntry = addressEntry[asset];
          assetEntry = assetEntry - quantity;
          if (assetEntry > 0) {
            addressEntry[asset] = assetEntry;
          } else {
            delete addressEntry[asset];

            if (Object.keys(addressEntry).length === 0) {
              delete newDb.balances[address];
            }
          }
        } else if (type === 'drop') {
          const {address, asset, quantity} = payloadJson

          let addressEntry = newDb.balances[address];
          if (addressEntry === undefined) {
            addressEntry = {};
            newDb.balances[address] = addressEntry;
          }
          let assetEntry = addressEntry[asset];
          assetEntry = assetEntry - quantity;
          if (assetEntry > 0) {
            addressEntry[asset] = assetEntry;
          } else {
            delete addressEntry[asset];

            if (Object.keys(addressEntry).length === 0) {
              delete newDb.balances[address];
            }
          }
        } else if (type === 'minter') {
          const {asset, publicKey} = payloadJson;
          const mintAsset = asset + ':mint';
          const publicKeyBuffer = new Buffer(publicKey, 'base64');
          const address = _getAddressFromPublicKey(publicKeyBuffer);

          let addressEntry = newDb.balances[address];
          if (addressEntry === undefined) {
            addressEntry = {};
            newDb.balances[address] = addressEntry;
          }
          let mintAssetEntry = addressEntry[mintAsset];
          if (mintAssetEntry === undefined) {
            mintAssetEntry = 0;
          }
          mintAssetEntry = mintAssetEntry + 1;
          addressEntry[mintAsset] = mintAssetEntry;

          newDb.minters[asset] = address;
        } else {
          throw new Error('internal error: committing a block with unknown message type ' + JSON.stringify(type));
        }
      }

      // update message revocations
      newDb.messageHashes.push(block.messages.map(({hash}) => hash));
      while (newDb.messageHashes.length > MESSAGE_TTL) {
        newDb.messageHashes.shift();
      }

      const newMempool = mempool && {
        blocks: mempool.blocks.filter(mempoolBlock => mempoolBlock.hash !== block.hash),
        messages: mempool.messages.filter(mempoolMessage => !block.messages.some(blockMessage => blockMessage.signature === mempoolMessage.signature)),
      };

      // XXX need to re-validate whole mempool here, since the new block might have broken validity

      return {
        newDb,
        newMempool,
      };
    };
    const _commitSideChainBlock = (dbs, blocks, mempool, block, forkedBlock, sideChainBlocks) => {
      const _getBlocksTotalDifficulty = blocks => {
        let result = 0;
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          const {hash} = block;
          result += _getHashDifficulty(hash);
        }
        return result;
      };
      const forkedBlockHeight = forkedBlock ? forkedBlock.height : 0;
      const mainChainDifficulty = _getBlocksTotalDifficulty(blocks.slice(forkedBlockHeight));
      const sideChainDifficulty = _getBlocksTotalDifficulty(sideChainBlocks.slice(forkedBlockHeight));
      const needsReorg = sideChainDifficulty > mainChainDifficulty;

      const _getBlocksMessages = blocks => {
        const result = [];
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          const {messages} = block;

          for (let j = 0; j < messages; j++) {
            const message = messages[j];
            result.push(message);
          }
        }
        return result;
      };
      const forkedBlockIndex = forkedBlockHeight - 1;
      const topBlockIndex = blocks.length - 1;
      const numSlicedBlocks = topBlockIndex - forkedBlockIndex;
      const slicedBlocks = blocks.slice(-numSlicedBlocks);
      const slicedMessages = _getBlocksMessages(slicedBlocks);
      const topSideChainBlockIndex = sidechainBlocks.length - 1;
      const numAddedSideChainBlocks = topSideChainBlockIndex - forkedBlockIndex;
      const addedSideChainBlocks = sideChainBlocks.slice(-numAddedSideChainBlocks);
      const addedSideChainMessages = _getBlocksMessages(addedSideChainBlocks);

      const newDbs = (() => {
        if (needsReorg) {
          const result = dbs.slice(0, -numSlicedBlocks);

          let localDb = (numSlicedBlocks < dbs.length) ? dbs[dbs.length - (numSlicedBlocks + 1)] : DEFAULT_DB;
          let localBlocks = blocks.slice(0, -numSlicedBlocks);
          for (let i = 0; i < addedSideChainBlocks; i++) {
            const addedSideChainBlock = addedSideChainBlocks;
            const {newDb} = _commitMainChainBlock(localDb, localBlocks, null, addedSideChainBlock);
            localDb = newDb;
            localBlocks.push(addedSideChainBlock);

            result.push(localDb);
          }

          return result;
        } else {
          return dbs.slice();
        }
      })();

      const newBlocks = needsReorg ? sideChainBlocks.slice() : blocks.slice();
      const newMempool = (() => {
        if (needsReorg) {
          const newMempool = {
            blocks: mempool.blocks
              .filter(mempoolBlock => !addedSideChainBlocks.some(addedSideChainBlock => addedSideChainBlock.hash === mempoolBlock.hash))
              .concat(slicedBlocks),
            messages: mempool.messages
              .filter(mempoolMessage => !addedSideChainMessages.some(addedSideChainMessage => addedSideChainMessage.signature === mempoolMessage.signature)),
          };
          // try to re-add sliced messges; they might not be valid anymore so we can't just append them
          for (let i = 0; i < slicedMessages.length; i++) {
            const slicedMessage = slicedMessages[i];
            this.addMessage(newDb, newBlocks, newMempool, slicedMessage);
          }

          // XXX need to re-validate whole mempool here, since the new block might have broken validity

          return newMempool;
        } else {
          return {
            blocks: mempool.blocks.concat(block),
            messages: mempool.messages.slice(),
          };
        }
      })();

      return {
        newDbs,
        newBlocks,
        newMemPool,
      };
    };

    if (!_checkBlockExists(this.blocks, this.mempool, block)) {
      const attachPoint = _findBlockAttachPoint(this.blocks, this.mempool, block);

      if (attachPoint !== null) {
        const {type} = attachPoint;

        if (type === 'mainChain') {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const error = block.verify(db, this.blocks);
          if (!error) {
            const {newDb, newMempool} = _commitMainChainBlock(db, this.blocks, this.mempool, block);
            this.dbs.push(newDb);
            while (this.dbs.length > UNDO_HEIGHT) {
              this.dbs.shift();
            }
            this.blocks.push(block);
            while (this.blocks.length > CHARGE_SETTLE_BLOCKS) {
              this.blocks.shift();
            }
            this.mempool.blocks = newMempool.blocks;
            this.mempool.messages = newMempool.messages;

            this.saveState();

            this.emit('block', block);

            return null;
          } else {
            return error;
          }
        } else if (type === 'sideChain') {
          const {forkedBlock, sideChainBlocks} = attachPoint;

          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const error = block.verify(db, sideChainBlocks);
          if (!error) {
            const {newDbs, newBlocks, newMempool} = _commitSideChainBlock(this.dbs, this.blocks, this.mempool, block, forkedBlock, sideChainBlocks);
            this.dbs = newDbs;
            while (this.dbs.length > UNDO_HEIGHT) {
              this.dbs.shift();
            }
            this.blocks = newBlocks;
            while (this.blocks.length > CHARGE_SETTLE_BLOCKS) {
              this.blocks.shift();
            }
            this.mempool.blocks = newMempool.blocks;
            this.mempool.messages = newMempool.messages;

            this.saveState();

            this.emit('block', block);

            return null;
          } else {
            return error;
          }
        } else if (type === 'outOfRange') {
          const {direction} = attachPoint;

          if (direction === -1) {
            return {
              status: 400,
              error: 'stale block',
              soft: true,
            };
          } else {
            return {
              status: 400,
              error: 'desynchronized block',
              soft: true,
            };
          }
        } else if (type === 'dangling') {
          return {
            status: 400,
            error: 'dangling block',
            soft: true,
          };
        } else {
          return {
            status: 400,
            error: 'internal block attach error',
          };
        }
      } else {
        return {
          status: 400,
          error: 'invalid block',
        };
      }
    } else {
      return {
        status: 400,
        error: 'block exists',
        soft: true,
      };
    }
  }

  loadState() {
    const {dataDirectory} = this;
    const dbDataPath = path.join(dataDirectory, 'db');
    const blocksDataPath = path.join(dataDirectory, 'blocks');

    const _readdirDbs = () => new Promise((accept, reject) => {
      fs.readdir(dbDataPath, (err, files) => {
        if (!err || err.code === 'ENOENT') {
          files = files || [];

          accept(files);
        } else {
          reject(err);
        }
      });
    });
    const _readdirBlocks = () => new Promise((accept, reject) => {
      fs.readdir(blocksDataPath, (err, files) => {
        if (!err || err.code === 'ENOENT') {
          files = files || [];

          accept(files);
        } else {
          reject(err);
        }
      });
    });
    const _decorateBlocks = blocks => {
      for (let i = 0; i < blocks.length; i++) {
        blocks[i] = Block.from(blocks[i]);
      }
    };

    return Promise.all([
      _readdirDbs(),
      _readdirBlocks(),
    ])
      .then(([
        dbFiles,
        blockFiles,
      ]) => {
        const bestBlockHeight = (() => {
          const blockHeightIndex = {};
          for (let i = 0; i < blockFiles.length; i++) {
            const blockFile = blockFiles[i];
            const match = blockFile.match(/^block-([0-9]+)\.json$/);

            if (match) {
              const height = match[1];
              blockHeightIndex[height] = true;
            }
          }

          for (let height = 1; height <= blockFiles.length; height++) {
            if (!blockHeightIndex[height]) {
              return height - 1;
            }
          }
          return blockFiles.length;
        })();

        if (bestBlockHeight > 0) { // load dbs and blocks from disk
          const _readDbFiles = () => {
            const candidateHeights = (() => {
              const result = [];

              const _haveDbFile = height => dbFiles.some(file => {
                const match = file.match(/^db-([0-9]+)\.json$/);
                return Boolean(match) && parseInt(match[1], 10) === height;
              });
              for (let i = bestBlockHeight; (i >= (bestBlockHeight - UNDO_HEIGHT)) && (i > 0) && _haveDbFile(i); i--) {
                result.unshift(i);
              }
              return result;
            })();
            const _readDbFile = height => new Promise((accept, reject) => {
              fs.readFile(path.join(dbDataPath, `db-${height}.json`), 'utf8', (err, s) => {
                if (!err) {
                  const db = JSON.parse(s);
                  accept(db);
                } else {
                  reject(err);
                }
              });
            });
            return Promise.all(candidateHeights.map(height => _readDbFile(height)));
          };
          const _readBlockFiles = () => {
            const candidateHeights = (() => {
              const result = [];
              for (let i = Math.max(bestBlockHeight - CHARGE_SETTLE_BLOCKS, 1); i <= bestBlockHeight; i++) {
                result.push(i);
              }
              return result;
            })();
            const _readBlockFile = height => new Promise((accept, reject) => {
              fs.readFile(path.join(blocksDataPath, `block-${height}.json`), 'utf8', (err, s) => {
                if (!err) {
                  const block = JSON.parse(s);
                  accept(block);
                } else {
                  reject(err);
                }
              });
            });
            return Promise.all(candidateHeights.map(height => _readBlockFile(height)));
          };

          return Promise.all([
            _readDbFiles(),
            _readBlockFiles(),
          ])
            .then(([
              newDbs,
              newBlocks,
            ]) => {
              // NOTE: we are assuming no file corruption
              this.dbs = newDbs;
              this.blocks = newBlocks;
              _decorateBlocks(this.blocks);
            });
        } else { // nothing to salvage; bootstrap db and do a full sync
          this.dbs = [];
          this.blocks = [];
          _decorateBlocks(this.blocks);

          return Promise.resolve();
        }
      });
  }

  saveState() {
    const {dataDirectory} = this;
    const dbDataPath = path.join(dataDirectory, 'db');
    const blocksDataPath = path.join(dataDirectory, 'blocks');

    const _doSave = cb => {
      const _writeNewFiles = () => {
        const promises = [];
        const _writeFile = (p, d) => new Promise((accept, reject) => {
          writeFileAtomic(p, d, err => {
            if (!err || err.code === 'ENOENT') {
              accept();
            } else {
              reject(err);
            }
          });
        });
        const zerothDbLocalBlockIndex = Math.max(this.blocks.length - UNDO_HEIGHT, 0);
        for (let i = 0; i < this.blocks.length; i++) {
          const block = this.blocks[i];
          const {height} = block;
          promises.push(_writeFile(path.join(blocksDataPath, `block-${height}.json`), JSON.stringify(block, null, 2)));

          if (i >= zerothDbLocalBlockIndex) {
            const dbIndex = i - zerothDbLocalBlockIndex;
            const db = this.dbs[dbIndex];
            promises.push(_writeFile(path.join(dbDataPath, `db-${height}.json`), JSON.stringify(db, null, 2)));
          }
        }

        return Promise.all(promises);
      };
      const _removeOldFiles = () => {
        const _removeDbFiles = () => new Promise((accept, reject) => {
          fs.readdir(dbDataPath, (err, dbFiles) => {
            if (!err || err.code === 'ENOENT') {
              dbFiles = dbFiles || [];

              const keepDbFiles = [];
              const zerothDbLocalBlockIndex = Math.max(this.blocks.length - UNDO_HEIGHT, 0);
              for (let i = zerothDbLocalBlockIndex; i < this.blocks.length; i++) {
                const block = this.blocks[i];
                const {height} = block;
                keepDbFiles.push(`db-${height}.json`);
              }

              const promises = [];
              const _removeFile = p => new Promise((accept, reject) => {
                fs.unlink(p, err => {
                  if (!err || err.code === 'ENOENT') {
                    accept();
                  } else {
                    reject(err);
                  }
                });
              });
              for (let i = 0; i < dbFiles.length; i++) {
                const dbFile = dbFiles[i];

                if (!keepDbFiles.includes(dbFile)) {
                  promises.push(_removeFile(path.join(dbDataPath, dbFile)));
                }
              }

              Promise.all(promises)
                .then(accept)
                .catch(reject);
            } else {
              reject(err);
            }
          });
        });
        const _removeBlockFiles = () => new Promise((accept, reject) => {
          fs.readdir(blocksDataPath, (err, blockFiles) => {
            if (!err || err.code === 'ENOENT') {
              blockFiles = blockFiles || [];

              const promises = [];
              const _removeFile = p => new Promise((accept, reject) => {
                fs.unlink(p, err => {
                  if (!err || err.code === 'ENOENT') {
                    accept();
                  } else {
                    reject(err);
                  }
                });
              });
              const topBlockHeight = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;
              for (let i = 0; i < blockFiles.length; i++) {
                const blockFile = blockFiles[i];
                const match = blockFile.match(/^block-([0-9]+)\.json$/);

                const _remove = () => {
                  promises.push(_removeFile(path.join(blocksDataPath, blockFile)));
                };

                if (match) {
                  const height = parseInt(match[1], 10);

                  if (height >= 1 && height <= topBlockHeight) {
                    // nothing
                  } else {
                    _remove();
                  } 
                } else {
                  _remove();
                }
              }

              Promise.all(promises)
                .then(accept)
                .catch(reject);
            } else {
              reject(err);
            }
          });
        });

        return Promise.all([
          _removeDbFiles(),
          _removeBlockFiles(),
        ]);
      };

      _writeNewFiles()
        .then(() => _removeOldFiles())
        .then(() => {
          cb();
        })
        .catch(err => {
          cb(err);
        });
    };

    let queued = false;
    const _recurse = () => {
      if (!this.saveStateRunning) {
        this.saveStateRunning = true;

        _doSave(err => {
          if (err) {
            console.warn(err);
          }

          this.saveStateRunning = false;

          if (queued) {
            queued = false;

            _recurse();
          } else {
            for (let i = 0; i < this.saveStateCbs.length; i++) {
              this.saveStateCbs[i]();
            }
          }
        });
      } else {
        queued = true;
      }
    };
    return _recurse;
  }

  loadPeers() {
    const {dataDirectory} = this;
    const peersDataPath = path.join(dataDirectory, 'peers.txt');

    return new Promise((accept, reject) => {
      fs.readFile(peersDataPath, 'utf8', (err, s) => {
        if (!err) {
          const newPeers = s.split('\n')
            .filter(url => url)
            .map(url => new Peer(url));
          this.peers = newPeers;

          accept();
        } else if (err.code === 'ENOENT') {
          this.peers = [];

          accept();
        } else {
          reject(err);
        }
      });
    });
  }

  savePeers() {
    const {dataDirectory} = this;
    const peersDataPath = path.join(dataDirectory, 'peers.txt');

    const _doSave = cb => {
      const peersString = this.peers.map(({url}) => url).join('\n') + '\n';

      fs.writeFile(peersDataPath, peersString, err => {
        if (!err) {
          cb();
        } else {
          cb(err);
        }
      });
    };

    let queued = false;
    const _recurse = () => {
      if (!this.savePeersRunning) {
        this.savePeersRunning = true;

        _doSave(err => {
          if (err) {
            console.warn(err);
          }

          this.savePeersRunning = false;

          if (queued) {
            queued = false;

            _recurse();
          } else {
            for (let i = 0; i < this.savePeersCbs.length; i++) {
              this.savePeersCbs[i]();
            }
          }
        });
      } else {
        queued = true;
      }
    };
    return _recurse;
  }

  addPeer(url) {
    const {host, port} = this;

    const peer = new Peer(url);
    if (peer.url !== `http://${host}:${port}` && !this.peers.some(p => p.equals(peer))) {
      this.peers.push(peer);

      this.emit('peer', peer.url);

      this.refreshLivePeers();

      this.savePeers();
    }
  }

  removePeer(url) {
    const index = this.peers.findIndex(peer => peer.url === url);
    if (index !== -1) {
      const peer = this.peers[index];
      peer.disable();
      this.peers.splice(index, 1);

      this.refreshLivePeers();

      this.savePeers();
    }
  }

  refreshLivePeers() {
    const enabledPeers = this.peers.filter(peer => peer.isEnabled());
    const disabledPeers = this.peers.filter(peer => !peer.isEnabled());

    while (enabledPeers.length < MIN_NUM_LIVE_PEERS && disabledPeers.length > 0) {
      const disabledPeerIndex = Math.floor(disabledPeers.length * Math.random());
      const peer = disabledPeers[disabledPeerIndex];
      peer.enable(this);

      disabledPeers.splice(disabledPeerIndex, 1);
      enabledPeers.push(peer);
    }
  }

  listen({
    host = DEFAULTS.host,
    port = DEFAULTS.port,
  } = {}) {
    const {dataDirectory} = this;

    let lastBlockTime = Date.now();
    let numHashes = 0;
    const doHash = () => new Promise((accept, reject) => {
      const version = BLOCK_VERSION;
      const prevHash = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].hash : zeroHash;
      const topBlockHeight = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;
      const height = topBlockHeight + 1;
      const minTimestamp = _getNextBlockMinTimestamp(this.blocks);
      const now = Date.now();
      const timestamp = Math.max(now, minTimestamp);
      const payload = JSON.stringify({type: 'coinbase', asset: CRD, quantity: COINBASE_QUANTITY, address: mineAddress, startHeight: height, timestamp});
      const payloadHash = crypto.createHash('sha256').update(payload).digest();
      const payloadHashString = payloadHash.toString('hex');
      const privateKeyBuffer = NULL_PRIVATE_KEY;
      const signature = eccrypto.sign(privateKeyBuffer, payloadHash);
      const signatureString = signature.toString('base64');
      const coinbaseMessage = new Message(payload, payloadHashString, signatureString);
      const allMessages = this.mempool.messages
        .slice(0, MESSAGES_PER_BLOCK_MAX - 1) // -1 for coinbase
        .concat(coinbaseMessage);
      const allMessagesJson = allMessages
        .map(message => JSON.stringify(message))
        .join('\n');
      const baseDifficulty = _getNextBlockBaseDifficulty(this.blocks);
      const bonusDifficulty = _getMessagesDifficulty(allMessages);
      const difficulty = Math.max(baseDifficulty - bonusDifficulty, MIN_DIFFICULTY);
      const target = _getDifficultyTarget(difficulty);

      const uint64Array = new Uint32Array(1);
      const hashRoot = (() => {
        const hasher = crypto.createHash('sha256');
        hasher.update(prevHash);
        hasher.update(':');
        uint64Array[0] = height;
        hasher.update(uint64Array);
        hasher.update(':');
        uint64Array[0] = difficulty;
        hasher.update(uint64Array);
        hasher.update(':');
        hasher.update(version);
        hasher.update(':');
        uint64Array[0] = timestamp;
        hasher.update(uint64Array);
        hasher.update(':');
        hasher.update(allMessagesJson);
        hasher.update(':');
        return hasher.digest();
      })();

      for (let nonce = 0;; nonce++) {
        const hasher = crypto.createHash('sha256');
        hasher.update(hashRoot);
        uint64Array[0] = nonce;
        hasher.update(uint64Array);
        const hash = hasher.digest('hex');

        if (_checkHashMeetsTarget(hash, target)) {
          const block = new Block(hash, prevHash, height, difficulty, version, timestamp, allMessages, nonce);
          accept(block);

          return;
        } else {
          const now = Date.now();
          const timeDiff = now - timestamp;

          if (timeDiff > HASH_WORK_TIME) {
            accept(null);

            return;
          } else {
            numHashes++;
          }
        }
      }
    });

    const dbDataPath = path.join(dataDirectory, 'db');
    const blocksDataPath = path.join(dataDirectory, 'blocks');
    const _ensureDataPaths = () => {
      const dataDirectories = [
        dataDirectory,
        dbDataPath,
        blocksDataPath,
      ];
      const _ensureDirectory = p => new Promise((accept, reject) => {
        mkdirp(p, err => {
          if (!err) {
            accept();
          } else {
            reject(err);
          }
        });
      });
      return Promise.all(dataDirectories.map(p => _ensureDirectory(p)));
    };

    const _listen = () => {
      const _createSend = ({asset, quantity, srcAddress, dstAddress, startHeight, timestamp, privateKey}) => {
        const privateKeyBuffer = new Buffer(privateKey, 'base64');
        const publicKey = eccrypto.getPublic(privateKeyBuffer);
        const publicKeyString = publicKey.toString('base64');
        const payload = JSON.stringify({type: 'send', asset, quantity, srcAddress, dstAddress, publicKey: publicKeyString, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createMinter = ({asset, startHeight, timestamp, privateKey}) => {
        const privateKeyBuffer = new Buffer(privateKey, 'base64');
        const publicKey = eccrypto.getPublic(privateKeyBuffer);
        const publicKeyString = publicKey.toString('base64');
        const address = _getAddressFromPrivateKey(privateKeyBuffer);
        const payload = JSON.stringify({type: 'minter', address, asset, publicKey: publicKeyString, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createPrice = ({asset, price, startHeight, timestamp, privateKey}) => {
        const privateKeyBuffer = new Buffer(privateKey, 'base64');
        const publicKey = eccrypto.getPublic(privateKeyBuffer);
        const publicKeyString = publicKey.toString('base64');
        const payload = JSON.stringify({type: 'price', asset, price, publicKey: publicKeyString, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createBuy = ({asset, quantity, price, startHeight, timestamp, privateKey}) => {
        const privateKeyBuffer = new Buffer(privateKey, 'base64');
        const publicKey = eccrypto.getPublic(privateKeyBuffer);
        const publicKeyString = publicKey.toString('base64');
        const payload = JSON.stringify({type: 'buy', asset, quantity, price, publicKey: publicKeyString, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createMint = ({asset, quantity, startHeight, timestamp, privateKey}) => {
        const privateKeyBuffer = new Buffer(privateKey, 'base64');
        const publicKey = eccrypto.getPublic(privateKeyBuffer);
        const publicKeyString = publicKey.toString('base64');
        const payload = JSON.stringify({type: 'mint', asset, quantity, publicKey: publicKeyString, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createGet = ({address, asset, quantity, startHeight, timestamp}) => {
        const privateKeyBuffer = NULL_PRIVATE_KEY;
        const payload = JSON.stringify({type: 'get', address, asset, quantity, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createBurn = ({asset, quantity, privateKey, startHeight, timestamp}) => {
        const privateKeyBuffer = new Buffer(privateKey, 'base64');
        const publicKey = eccrypto.getPublic(privateKeyBuffer);
        const publicKeyString = publicKey.toString('base64');
        const payload = JSON.stringify({type: 'burn', asset, quantity, publicKey, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };
      const _createDrop = ({address, asset, quantity, startHeight, timestamp}) => {
        const privateKeyBuffer = NULL_PRIVATE_KEY;
        const payload = JSON.stringify({type: 'drop', address, asset, quantity, startHeight, timestamp});
        const payloadHash = crypto.createHash('sha256').update(payload).digest();
        const payloadHashString = payloadHash.toString('hex');
        const signature = eccrypto.sign(privateKeyBuffer, payloadHash)
        const signatureString = signature.toString('base64');
        const message = new Message(payload, payloadHashString, signatureString);
        const error = this.submitMessage(message);
        if (!error) {
          return Promise.resolve();
        } else {
          return Promise.reject(error);
        }
      };

      const _requestServer = () => new Promise((accept, reject) => {
        const app = express();

        app.all('*', (req, res, next) => {
          if (/^(?:::ffff:)?127\.0\.0\.1$/.test(req.connection.remoteAddress)) {
            next();
          } else {
            res.status(401);
            res.send();
          }
        });

        app.get('/status', (req, res, next) => {
          const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
          const timestamp = Date.now();

          res.json({
            startHeight,
            timestamp,
          });
        });
        app.get('/assets', (req, res, next) => {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const assets = Object.keys(db.minters);
          res.json(assets);
        });
        app.get('/balances/:address', (req, res, next) => {
          const {address} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const balances = _getConfirmedBalances(db, [], address);
          res.json(balances);
        });
        app.get('/balance/:address/:asset', (req, res, next) => {
          const {address, asset} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const balance = _getConfirmedBalance(db, [], address, asset);
          res.json(balance);
        });
        app.get('/unconfirmedBalances/:address', (req, res, next) => {
          const {address} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const balances = _getUnconfirmedBalances(db, this.mempool, [], address);
          res.json(balances);
        });
        app.get('/unconfirmedBalance/:address/:asset', (req, res, next) => {
          const {address, asset} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const balance = _getUnconfirmedBalance(db, this.mempool, [], address, asset);
          res.json(balance);
        });
        app.get('/minter/:asset', (req, res, next) => {
          const {asset} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const minter = _getConfirmedMinter(db, [], asset);
          res.json(minter);
        });
        app.get('/unconfirmedMinter/:asset', (req, res, next) => {
          const {asset} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const minter = _getUnconfirmedMinter(db, this.mempool, [], asset);
          res.json(minter);
        });
        app.get('/price/:asset', (req, res, next) => {
          const {asset} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const price = _getConfirmedPrice(db, [], asset);
          res.json(price);
        });
        app.get('/unconfirmedPrice/:asset', (req, res, next) => {
          const {asset} = req.params;
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const price = _getUnconfirmedPrice(db, this.mempool, [], asset);
          res.json(price);
        });
        app.post('/submitMessage', bodyParserJson, (req, res, next) => {
          const {body} = req;
          const message = Message.from(body);

          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const error = this.submitMessage(message);

          if (!error) {
            res.json({
              ok: true,
            });
          } else {
            res.status(error.status || 500);
            res.json({error: error.error || error.stack});
          }
        });
        app.post('/mine', bodyParserJson, (req, res, next) => {
          const {body} = req;

          if (body && body.address && typeof body.address === 'string') {
            const {address} = body;
            _startMine(address);

            res.json({
              ok: true,
            });
          } else if (body && body.address === null) {
            _stopMine();

            res.json({
              ok: true,
            });
          } else {
            res.status(400);
            res.json({
              error: 'invalid address',
            });
          }
        });
        app.get('/minedBlocks', bodyParserJson, (req, res, next) => {
          res.json(minedBlocks);
        });
        app.get('/blocks/:height', (req, res, next) => {
          const {height: heightStirng} = req.params;
          const height = parseInt(heightStirng, 10);

          if (!isNaN(height)) {
            const topBlockHeight = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;

            if (height >= 1 && height <= topBlockHeight) {
              const firstBlockHeight = this.blocks[0].height;

              if (height >= firstBlockHeight) {
                const blockIndex = height - firstBlockHeight;
                const block = this.blocks[blockIndex];
                res.type('application/json');
                res.send(JSON.stringify(block, null, 2));
              } else {
                const rs = fs.createReadStream(path.join(blocksDataPath, `block-${height}.json`));
                res.type('application/json');
                rs.pipe(res);
                rs.on('error', err => {
                  console.warn(err);

                  res.status(500);
                  res.send(err.stack);
                });
              }
            } else {
              res.status(404);
              res.json({
                error: 'height out of range',
              });
            }
          } else {
            res.status(400);
            res.json({
              error: 'invalid height',
            });
          }
        });
        /* app.get('/blockcount', (req, res, next) => {
          const blockcount = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;

          res.json({
            blockcount,
          });
        }); */
        app.get('/blockcache', (req, res, next) => {
          res.json(this.blocks);
        });
        app.get('/mempool', (req, res, next) => {
          res.json(this.mempool);
        });
        app.get('/peers', (req, res, next) => {
          const urls = this.peers.map(({url}) => url);
          res.json(urls);
        });
        app.post('/peer', bodyParserJson, (req, res, next) => {
          const {body} = req;

          if (body && body.url && typeof body.url === 'string') {
            const {url} = body;
            this.addPeer(url);

            res.json({
              ok: true,
            });
          } else {
            res.status(400);
            res.json({
              error: 'invalid address',
            });
          }
        });

        const server = http.createServer(app)
        const wss = new ws.Server({
          noServer: true,
        });
        const connections = [];
        server[connectionsSymbol] = connections;
        wss.on('connection', c => {
          const {url} = c.upgradeReq;

          if (url === '/listen') {
            connections.push(c);

            c.on('close', () => {
              connections.splice(connections.indexOf(c), 1);
            });
          } else {
            c.close();
          }
        });
        server.on('upgrade', (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, c => {
            c.upgradeReq = req;

            wss.emit('connection', c);
          });
        });
        server.listen(port, host, err => {
          if (!err) {
            accept(server);
          } else {
            reject(err);
          }
        });
      });
      const _requestRefreshPeers = () => {
        this.refreshLivePeers();

        return Promise.resolve();
      };
      const _requestListenApi = server => {
        const connections = server[connectionsSymbol];

        this.on('block', block => {
          const e = {
            type: 'block',
            block: block,
          };
          const es = JSON.stringify(e);

          for (let i = 0; i < connections.length; i++) {
            const connection = connections[i];
            if (connection.readyState === ws.OPEN) {
              connection.send(es);
            }
          }
        });
        this.on('message', message => {
          const e = {
            type: 'message',
            message: message,
          };
          const es = JSON.stringify(e);

          for (let i = 0; i < connections.length; i++) {
            const connection = connections[i];
            if (connection.readyState === ws.OPEN) {
              connection.send(es);
            }
          }
        });
        this.on('peer', peer => {
          const e = {
            type: 'peer',
            peer: peer,
          };
          const es = JSON.stringify(e);

          for (let i = 0; i < connections.length; i++) {
            const connection = connections[i];
            if (connection.readyState === ws.OPEN) {
              connection.send(es);
            }
          }
         });

        return Promise.resolve();
      };

      return _requestServer()
        .then(server =>
          Promise.all([
            _requestRefreshPeers(),
            _requestListenApi(server),
          ])
            .then(() => server)
        );
    };

    let mineAddress = null;
    let minedBlocks = 0;
    let mineImmediate = null;
    const _mine = () => {
      doHash()
        .then(block => {
          if (block !== null) {
            const now = Date.now();
            const timeDiff = now - lastBlockTime;
            lastBlockTime = now;
            numHashes = 0;

            const error = this.addBlock(block);
            if (!error) {
              const difficulty = _getNextBlockBaseDifficulty(this.blocks);
              const timeTaken = timeDiff / 1000;
              minedBlocks++;

              // console.log('mined block', difficulty, timeTaken);
            } else {
              console.warn('add mined block error:', error);
            }
          }

          mineImmediate = setImmediate(_mine);
        })
        .catch(err => {
          console.warn(err.stack);

          setTimeout(_mine, 1000);
        });
    };
    const _startMine = address => {
      _stopMine();

      mineAddress = address;
      mineImmediate = setImmediate(_mine);
    };
    const _stopMine = () => {
      mineAddress = null;

      clearImmediate(mineImmediate);
      mineImmediate = null;
    };

    return Promise.all([
      this.loadState(),
      this.loadPeers(),
    ])
      .then(() => _ensureDataPaths())
      .then(() => _listen())
      .then(server => {
        return cb => {
          _stopMine();

          for (let i = 0; i < this.peers.length; i++) {
            const peer = this.peers[i];
            peer.disable();
          }

          Promise.all([
            new Promise((accept, reject) => {
              server.close(err => {
                if (!err) {
                  accept();
                } else {
                  reject(err);
                }
              });
            }),
            new Promise((accept, reject) => {
              if (this.saveStateRunning) {
                this.saveStateCbs.push(accept);
              } else {
                accept();
              }
            }),
          ])
            .then(() => {
              cb && cb();
            })
            .catch(err => {
              cb && cb(err);
            });
        };
      });
  }

  cli() {
    const {dataDirectory} = this;

    const commands = {
      db: args => {
        const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
        console.log(JSON.stringify(db, null, 2));
        process.stdout.write('> ');
      },
      blockcount: args => {
        const blockcount = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;
        console.log(JSON.stringify(blockcount, null, 2));
        process.stdout.write('> ');
      },
      blockcache: args => {
        console.log(JSON.stringify(this.blocks, null, 2));
        process.stdout.write('> ');
      },
      mempool: args => {
        console.log(JSON.stringify(this.mempool.messages, null, 2));
        process.stdout.write('> ');
      },
      getaddress: args => {
        const privateKeyBuffer = crypto.randomBytes(32);
        const publicKeyBuffer = _getPublicKey(privateKeyBuffer);
        const address = _getAddressFromPublicKey(publicKeyBuffer);
        console.log(`PrivateKey: ${privateKeyBuffer.toString('base64')} PublicKey: ${publicKeyBuffer.toString('base64')} Address: ${address}`);
        process.stdout.write('> ');
      },
      parseaddress: args => {
        const [privateKey] = args;

        if (privateKey) {
          const privateKeyBuffer = new Buffer(privateKey, 'base64');
          const address = _getAddressFromPrivateKey(privateKeyBuffer);
          console.log(address);
          process.stdout.write('> ');
        } else {
          console.log('Enter a private key');
          process.stdout.write('> ')
        }
      },
      balance: args => {
        const [address, asset] = args;

        if (address && asset) {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const balance = _getUnconfirmedBalance(db, this.mempool, [], address, asset);
          console.log(JSON.stringify(balance, null, 2));
          const blockcount = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;
          console.log(`Blocks: ${blockcount} Mempool: ${this.mempool.messages.length}`);
          process.stdout.write('> ')
        } else if (address) {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const balances = _getUnconfirmedBalances(db, this.mempool, [], address);
          console.log(JSON.stringify(balances, null, 2));
          const blockcount = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;
          console.log(`Blocks: ${blockcount} Mempool: ${this.mempool.messages.length}`);
          process.stdout.write('> ');
        } else {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          console.log(JSON.stringify(_getAllUnconfirmedBalances(db, this.mempool), null, 2));
          const blockcount = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].height : 0;
          console.log(`Blocks: ${blockcount} Mempool: ${this.mempool.messages.length}`);
          process.stdout.write('> ');
        }
      },
      minter: args => {
        const [asset] = args;
        const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
        const minter = _getUnconfirmedMinter(db, this.mempool, [], asset);
        console.log(JSON.stringify(minter, null, 2));
        process.stdout.write('> ');
      },
      minters: args => {
        const [asset] = args;

        if (asset) {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const minter = _getUnconfirmedMinter(db, this.mempool, [], asset);
          console.log(JSON.stringify(minter, null, 2));
          process.stdout.write('> ');
        } else {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          console.log(JSON.stringify(db.minters, null, 2));
          process.stdout.write('> ');
        }
      },
      send: args => {
        const [asset, quantityString, srcAddress, dstAddress, privateKey] = args;
        const quantityNumber = parseInt(quantityString, 10);
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createSend({asset, quantity: quantityNumber, srcAddress, dstAddress, startHeight, timestamp, privateKey})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      minter: args => {
        const [asset, privateKey] = args;
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createMinter({asset, startHeight, timestamp, privateKey})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      price: args => {
        const [asset, price, privateKey] = args;
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createPrice({asset, price, startHeight, timestamp, privateKey})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      prices: args => {
        const [asset] = args;

        if (asset) {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          const price = _getUnconfirmedPrice(db, this.mempool, [], asset);
          console.log(JSON.stringify(price, null, 2));
          process.stdout.write('> ');
        } else {
          const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
          console.log(JSON.stringify(db.prices, null, 2));
          process.stdout.write('> ');
        }
      },
      buy: args => {
        const [asset, quantity, privateKey] = args;
        const db = (this.dbs.length > 0) ? this.dbs[this.dbs.length - 1] : DEFAULT_DB;
        const price = _getConfirmedPrice(db, [], asset);
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createBuy({asset, quantity, price, startHeight, timestamp, privateKey})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      mint: args => {
        const [asset, quantityString, privateKey] = args;
        const quantityNumber = parseInt(quantityString, 10);
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createMint({asset, quantity: quantityNumber, startHeight, timestamp, privateKey})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      get: args => {
        const [address, asset, quantityString] = args;
        const quantityNumber = parseInt(quantityString, 10);
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createGet({address, asset, quantity: quantityNumber, startHeight, timestamp})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      burn: args => {
        const [address, asset, quantityString] = args;
        const quantityNumber = parseInt(quantityString, 10);
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createBurn({address, asset, quantity: quantityNumber, startHeight, timestamp})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      drop: args => {
        const [address, asset, quantityString] = args;
        const quantityNumber = parseInt(quantityString, 10);
        const startHeight = ((this.blocks.length > 0) ? this.blocks[this.blocks.length - 1].height : 0) + 1;
        const timestamp = Date.now();

        _createDrop({address, asset, quantity: quantityNumber, startHeight, timestamp})
          .then(() => {
            console.log('ok');
            process.stdout.write('> ');
          })
          .catch(err => {
            console.warn(err);
          });
      },
      mine: args => {
        console.log(mineAddress !== null);
        process.stdout.write('> ');
      },
      startmine: args => {
        const [address] = args;

        if (address) {
          _startMine(address);
          process.stdout.write('> ');
        } else {
          console.warn('invalid address');
          process.stdout.write('> ');
        }
      },
      stopmine: args => {
        _stopMine();
        process.stdout.write('> ');
      },
      peers: args => {
        if (this.peers.length > 0) {
          console.log(this.peers.map(({url}) => url).join('\n'));
        }
        process.stdout.write('> ');
      },
      addpeer: args => {
        const [url] = args;

        this.addPeer(url);
        process.stdout.write('> ');
      },
      removepeer: args => {
        const [url] = args;

        this.removePeer(url);
        process.stdout.write('> ');
      },
      help: args => {
        console.log('Available commands:');
        console.log(
          Object.keys(commands)
            .map(cmd => '    ' + cmd)
            .join('\n')
        );
        process.stdout.write('> ');
      },
    };

    console.log(`CRDS blockchain ${VERSION}`);
    console.log(`Type 'help' for help.`);

    const r = repl.start({
      prompt: '> ',
      terminal: true,
      eval: (s, context, filename, callback) => {
        const split = s.split(/\s/);
        const cmd = split[0];
        const args = split.slice(1);

        const command = commands[cmd];
        if (command) {
          command(args);
        } else {
          if (/^.+\n$/.test(s)) {
            console.warn('invalid command');
          }
          process.stdout.write('> ');
        }
      },
    });
    replHistory(r, path.join(dataDirectory, 'history.txt'));
    r.on('exit', () => {
      this.emit('exit');

      process.on('SIGINT', () => {
        console.log('ignoring SIGINT');
      });
    });

    return Promise.resolve();
  }
}
const _clone = o => JSON.parse(JSON.stringify(o));
const _getPublicKey = privateKey => eccrypto.getPublic(privateKey);
const _getAddressFromPublicKey = publicKey => base58.encode(crypto.createHash('sha256').update(publicKey).digest());
const _getAddressFromPrivateKey = privateKey => _getAddressFromPublicKey(_getPublicKey(privateKey));
const _isValidAsset = asset => /^(?:[A-Z0-9]|(?!^)\-(?!$))+(\.(?:[A-Z0-9]|(?!^)\-(?!$))+)?(?::mint)?$/.test(asset);
const _isBasicAsset = asset => /^(?:[A-Z0-9]|(?!^)\-(?!$))+(\.(?:[A-Z0-9]|(?!^)\-(?!$))+)?$/.test(asset);
const _isBaseAsset = asset => /^(?:[A-Z0-9]|(?!^)\-(?!$))+$/.test(asset);
const _getBaseAsset = asset => asset.match(/^((?:[A-Z0-9]|(?!^)\-(?!$))+)/)[1];
const _isMintAsset = asset => /:mint$/.test(asset);
const _getAllConfirmedBalances = db => _clone(db.balances);
const _getConfirmedBalances = (db, confirmingMessages, address) => {
  let result = _clone(db.balances[address] || {});
  result = _getPostMessagesBalances(result, db, null, confirmingMessages, address, confirmingMessages);
  return result;
};
const _getConfirmedBalance = (db, confirmingMessages, address, asset) => {
  let result = (db.balances[address] || {})[asset];
  if (result === undefined) {
    result = 0;
  }
  result = _getPostMessagesBalance(result, db, null, confirmingMessages, address, asset, confirmingMessages);
  return result;
};
const _getAllUnconfirmedBalances = (db, mempool) => {
  const result = _getAllConfirmedBalances(db);

  for (let i = 0; i < mempool.messages.length; i++) {
    const message = mempool.messages[i];
    const payloadJson = JSON.parse(message.payload);
    const {type} = payloadJson;

    if (type === 'coinbase') {
      const {asset, quantity, address} = payloadJson;

      let addressEntry = result[address];
      if (addressEntry === undefined) {
        addressEntry = {};
        result[address] = addressEntry;
      }
      let assetEntry = addressEntry[asset];
      if (assetEntry === undefined) {
        assetEntry = 0;
      }
      addressEntry[asset] = assetEntry + quantity;
    } else if (type === 'send') {
      const {asset, quantity, srcAddress, dstAddress} = payloadJson;

      let srcAddressEntry = result[srcAddress];
      if (srcAddressEntry === undefined) {
        srcAddressEntry = {};
        result[srcAddress] = srcAddressEntry;
      }
      let srcAssetEntry = srcAddressEntry[asset];
      if (srcAssetEntry === undefined) {
        srcAssetEntry = 0;
      }
      srcAddressEntry[asset] = srcAssetEntry - quantity;

      let dstAddressEntry = result[dstAddress];
      if (dstAddressEntry === undefined) {
        dstAddressEntry = {};
        result[dstAddress] = dstAddressEntry;
      }
      let dstAssetEntry = dstAddressEntry[asset];
      if (dstAssetEntry === undefined) {
        dstAssetEntry = 0;
      }
      dstAddressEntry[asset] = dstAssetEntry + quantity;
    } else if (type === 'buy') {
      const {asset, quantity, price, publicKey} = payloadJson;
      const srcAddress = _getUnconfirmedMinter(db, mempool, [], asset);
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const dstAddress = _getAddressFromPublicKey(publicKeyBuffer);

      let srcAddressEntry = result[srcAddress];
      if (srcAddressEntry === undefined) {
        srcAddressEntry = {};
        result[srcAddress] = srcAddressEntry;
      }
      let srcAddressDstAssetEntry = srcAddressEntry[CRD];
      if (srcAddressDstAssetEntry === undefined) {
        srcAddressDstAssetEntry = 0;
      }
      srcAddressDstAssetEntry = srcAddressDstAssetEntry + (quantity * price);
      srcAddressEntry[CRD] = srcAddressDstAssetEntry;

      let dstAddressEntry = result[dstAddress];
      if (dstAddressEntry === undefined) {
        dstAddressEntry = {};
        result[dstAddress] = dstAddressEntry;
      }
      let dstAddressSrcAssetEntry = dstAddressEntry[CRD];
      if (dstAddressSrcAssetEntry === undefined) {
        dstAddressSrcAssetEntry = 0;
      }
      dstAddressSrcAssetEntry = dstAddressSrcAssetEntry - (quantity * price);
      dstAddressEntry[CRD] = dstAddressSrcAssetEntry;

      let dstAddressDstAssetEntry = dstAddressEntry[asset];
      if (dstAddressDstAssetEntry === undefined) {
        dstAddressDstAssetEntry = 0;
      }
      dstAddressDstAssetEntry = dstAddressDstAssetEntry + quantity;
      dstAddressEntry[asset] = dstAddressDstAssetEntry;
    } else if (type === 'mint') {
      const {asset, quantity, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const address = _getAddressFromPublicKey(publicKeyBuffer);

      let addressEntry = result[address];
      if (addressEntry === undefined) {
        addressEntry = {};
        result[address] = addressEntry;
      }
      let assetEntry = addressEntry[asset];
      if (assetEntry === undefined) {
        assetEntry = 0;
      }
      assetEntry = assetEntry + quantity;
      addressEntry[asset] = assetEntry;
    } else if (type === 'get') {
      const {address, asset, quantity} = payloadJson;

      let addressEntry = result[address];
      if (addressEntry === undefined) {
        addressEntry = {};
        result[address] = addressEntry;
      }
      let assetEntry = addressEntry[asset];
      if (assetEntry === undefined) {
        assetEntry = 0;
      }
      assetEntry = assetEntry + quantity;
      addressEntry[asset] = assetEntry;
    } else if (type === 'burn') {
      const {asset, quantity, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const address = _getAddressFromPublicKey(publicKeyBuffer);

      let addressEntry = result[address];
      if (addressEntry === undefined) {
        addressEntry = {};
        result[address] = addressEntry;
      }
      let assetEntry = addressEntry[asset];
      assetEntry = assetEntry - quantity;
      if (assetEntry > 0) {
        addressEntry[asset] = assetEntry;
      } else {
        delete addressEntry[asset];

        if (Object.keys(addressEntry).length === 0) {
          delete result[address];
        }
      }
    } else if (type === 'drop') {
      const {address, asset, quantity} = payloadJson;

      let addressEntry = result[address];
      if (addressEntry === undefined) {
        addressEntry = {};
        result[address] = addressEntry;
      }
      let assetEntry = addressEntry[asset];
      assetEntry = assetEntry - quantity;
      if (assetEntry > 0) {
        addressEntry[asset] = assetEntry;
      } else {
        delete addressEntry[asset];

        if (Object.keys(addressEntry).length === 0) {
          delete result[address];
        }
      }
    } else if (type === 'minter') {
      const {asset, publicKey} = payloadJson;
      const mintAsset = asset + ':mint';
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const address = _getAddressFromPublicKey(publicKeyBuffer);

      let addressEntry = result[address];
      if (addressEntry === undefined) {
        addressEntry = {};
        result[address] = addressEntry;
      }
      let mintAssetEntry = addressEntry[mintAsset];
      if (mintAssetEntry === undefined) {
        mintAssetEntry = 0;
      }
      mintAssetEntry = mintAssetEntry + 1;
      addressEntry[mintAsset] = mintAssetEntry;
    }
  }

  return result;
};
const _getUnconfirmedBalances = (db, mempool, confirmingMessages, address) => {
  let result = _getConfirmedBalances(db, confirmingMessages, address);
  result = _getPostMessagesBalances(result, db, mempool, confirmingMessages, address, mempool.messages);
  return result;
};
const _getPostMessagesBalances = (balances, db, mempool, confirmingMessages, address, messages) => {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const payloadJson = JSON.parse(message.payload);
    const {type} = payloadJson;

    if (type === 'coinbase') {
      const {asset, quantity, address: localAddress} = payloadJson;

      if (localAddress === address) {
        let assetEntry = balances[asset];
        if (assetEntry === undefined) {
          assetEntry = 0;
        }
        balances[asset] = assetEntry + quantity;
      }
    } else if (type === 'send') {
      const {asset, quantity, srcAddress, dstAddress} = payloadJson;

      if (srcAddress === address) {
        let srcAssetEntry = balances[asset];
        if (srcAssetEntry === undefined) {
          srcAssetEntry = 0;
        }
        balances[asset] = srcAssetEntry - quantity;
      }

      if (dstAddress === address) {
        let dstAssetEntry = balances[asset];
        if (dstAssetEntry === undefined) {
          dstAssetEntry = 0;
        }
        balances[asset] = dstAssetEntry + quantity;
      }
    } else if (type === 'buy') {
      const {asset, quantity, price, publicKey} = payloadJson;
      const srcAddress = !mempool ? _getConfirmedMinter(db, confirmingMessages, asset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, asset);
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const dstAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (srcAddress === address) {
        let assetEntry = balances[CRD];
        if (assetEntry === undefined) {
          assetEntry = 0;
        }
        balances[CRD] = assetEntry + (price * quantity);
      }

      if (dstAddress === address) {
        let crdEntry = balances[CRD];
        if (crdEntry === undefined) {
          crdEntry = 0;
        }
        balances[CRD] = crdEntry - (price * quantity);

        let assetEntry = balances[asset];
        if (assetEntry === undefined) {
          assetEntry = 0;
        }
        balances[asset] = assetEntry + quantity;
      }
    } else if (type === 'mint') {
      const {asset, quantity, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (localAddress === address) {
        let assetEntry = balances[asset];
        if (assetEntry === undefined) {
          assetEntry = 0;
        }
        assetEntry = assetEntry + quantity;
        balances[asset] = assetEntry;
      }
    } else if (type === 'get') {
      const {address: localAddress, asset, quantity} = payloadJson;

      if (localAddress === address) {
        let assetEntry = balances[asset];
        if (assetEntry === undefined) {
          assetEntry = 0;
        }
        assetEntry = assetEntry + quantity;
        balances[asset] = assetEntry;
      }
    } else if (type === 'burn') {
      const {asset, quantity, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (localAddress === address) {
        let assetEntry = balances[asset];
        assetEntry = assetEntry - quantity;
        if (assetEntry > 0) {
          balances[asset] = assetEntry;
        } else {
          delete balances[asset];
        }
      }
    } else if (type === 'drop') {
      const {address: localAddress, asset, quantity} = payloadJson;

      if (localAddress === address) {
        let assetEntry = balances[asset];
        assetEntry = assetEntry - quantity;
        if (assetEntry > 0) {
          balances[asset] = assetEntry;
        } else {
          delete balances[asset];
        }
      }
    } else if (type === 'minter') {
      const {asset, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (localAddress === address) {
        const mintAsset = asset + ':mint';

        let mintAssetEntry = balances[mintAsset];
        if (mintAssetEntry === undefined) {
          mintAssetEntry = 0;
        }
        mintAssetEntry = mintAssetEntry + 1;
        balances[mintAsset] = mintAssetEntry;
      }
    }
  }

  return balances;
};
const _getUnconfirmedBalance = (db, mempool, confirmingMessages, address, asset) => {
  let result = _getConfirmedBalance(db, confirmingMessages, address, asset);
  result = _getPostMessagesBalance(result, db, mempool, confirmingMessages, address, asset, mempool.messages);
  return result;
};
const _getPostMessagesBalance = (balance, db, mempool, confirmingMessages, address, asset, messages) => {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const payloadJson = JSON.parse(message.payload);
    const {type} = payloadJson;

    if (type === 'coinbase') {
      const {asset: localAsset, quantity, address: localAddress} = payloadJson;

      if (localAsset === asset && localAddress === address) {
        balance = balance + quantity;
      }
    } else if (type === 'send') {
      const {asset: a, quantity, srcAddress, dstAddress} = payloadJson;

      if (a === asset) {
        if (srcAddress === address) {
          balance = balance - quantity;
        }
        if (dstAddress === address) {
          balance = balance + quantity;
        }
      }
    } else if (type === 'buy') {
      const {asset: localAsset, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (asset === CRD) {
        const minter = !mempool ? _getConfirmedMinter(db, confirmingMessages, localAsset) : _getUnconfirmedMinter(db, mempool, confirmingMessages, localAsset);

        if (address === minter) {
          const {quantity, price} = payloadJson;
          balance = balance + (price * quantity);
        }
        if (address === localAddress) {
          balance = balance - (price * quantity);
        }
      } else {
        if (address === localAddress && asset === localAsset) {
          const {quantity, price} = payloadJson;
          balance = balance + quantity;
        }
      }
    } else if (type === 'mint') {
      const {asset: localAsset, quantity, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (localAddress === address && localAsset === asset) {
        balance = balance + quantity;
      }
    } else if (type === 'get') {
      const {address: localAddress, asset: localAsset, quantity} = payloadJson;

      if (localAddress === address && localAsset === asset) {
        balance = balance + quantity;
      }
    } else if (type === 'burn') {
      const {asset: localAsset, quantity, publicKey} = payloadJson;
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (localAddress === address && localAsset === asset) {
        balance = balance - quantity;
      }
    } else if (type === 'drop') {
      const {address: localAddress, asset: localAsset, quantity} = payloadJson;

      if (localAddress === address && localAsset === asset) {
        balance = balance - quantity;
      }
    } else if (type === 'minter') {
      const {asset: localAsset, publicKey} = payloadJson;
      const mintAsset = localAsset + ':mint';
      const publicKeyBuffer = new Buffer(publicKey, 'base64');
      const localAddress = _getAddressFromPublicKey(publicKeyBuffer);

      if (localAddress === address && mintAsset === asset) {
        balance = balance + 1;
      }
    }
  }

  return balance;
};
const _getConfirmedMinter = (db, confirmingMessages, asset) => {
  let minter = db.minters[asset];
  minter = _getPostMessagesMinter(minter, asset, confirmingMessages);
  return minter;
};
const _getUnconfirmedMinter = (db, mempool, confirmingMessages, asset) => {
  let minter = _getConfirmedMinter(db, confirmingMessages, asset);
  minter = _getPostMessagesMinter(minter, asset, mempool.messages);
  return minter;
};
const _getPostMessagesMinter = (minter, asset, messages) => {
  const mintMessages = messages.filter(message => {
    const payloadJson = JSON.parse(message.payload);
    return (payloadJson.type === 'minter' && payloadJson.asset === asset) ||
      (payloadJson.type === 'send' && payloadJson.asset === (asset + ':mint'));
  });

  let done = false;
  while (mintMessages.length > 0 && !done) {
    done = true;

    for (let i = 0; i < mintMessages.length; i++) {
      const message = mintMessages[i];
      const payloadJson = JSON.parse(message.payload);
      const {type} = payloadJson;

      if (type === 'minter') {
        if (minter === undefined) {
          const {publicKey} = payloadJson;
          const publicKeyBuffer = new Buffer(publicKey, 'base64');
          const address = _getAddressFromPublicKey(publicKeyBuffer);

          minter = address;
          done = false;
          mintMessages.splice(i, 1);
          break;
        }
      } else if (type === 'send') {
        const {srcAddress} = payloadJson;

        if (minter === srcAddress) {
          const {dstAddress} = payloadJson;

          minter = dstAddress;
          mintMessages.splice(i, 1);
          done = false;
          break;
        }
      }
    }
  }

  return minter;
};
const _getConfirmedPrice = (db, confirmingMessages, asset) => {
  const prices = _getConfirmedPrices(db, confirmingMessages, asset);
  return prices[prices.length - 1];
};
const _getUnconfirmedPrice = (db, mempool, confirmingMessages, asset) => {
  const prices = _getUnconfirmedPrices(db, mempool, confirmingMessages, asset);
  return prices[prices.length - 1];
};
const _getConfirmedPrices = (db, confirmingMessages, asset) => {
  let prices = [typeof db.prices[asset] === 'number' ? db.prices[asset] : Infinity];
  prices = _getPostMessagesPrices(prices, asset, confirmingMessages);
  return prices.map(price => price !== null ? price : Infinity);
};
const _getUnconfirmedPrices = (db, mempool, confirmingMessages, asset) => {
  let prices = _getConfirmedPrices(db, confirmingMessages, asset);
  prices = _getPostMessagesPrices(prices, asset, mempool.messages);
  return prices.map(price => price !== null ? price : Infinity);
};
const _getPostMessagesPrices = (prices, asset, messages) => prices
  .concat(
    messages
      .map(message => JSON.parse(message.payload))
      .filter(payloadJson => payloadJson.type === 'price' && payloadJson.asset === asset)
      .map(({price}) => price)
  );
const _getNextBlockMinTimestamp = blocks => {
  const checkBlocks = blocks.slice(-TARGET_BLOCKS);
  const sortedCheckBlocks = checkBlocks.slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const medianTimestamp = (() => {
    if (sortedCheckBlocks.length > 0) {
      const middleIndex = Math.floor((sortedCheckBlocks.length - 1) / 2);

      if (sortedCheckBlocks.length % 2) {
          return sortedCheckBlocks[middleIndex].timestamp;
      } else {
          return (sortedCheckBlocks[middleIndex].timestamp + sortedCheckBlocks[middleIndex + 1].timestamp) / 2;
      }
    } else {
      return 0;
    }
  })();
  return medianTimestamp;
};
const _getNextBlockBaseDifficulty = blocks => {
  const checkBlocks = blocks.slice(-TARGET_BLOCKS);
  const checkBlocksTimeDiff = (() => {
    if (checkBlocks.length > 0) {
      let firstCheckBlock = null;
      let lastCheckBlock = null;
      for (let i = 0; i < checkBlocks.length; i++) {
        const checkBlock = checkBlocks[i];

        if (firstCheckBlock === null || checkBlock.timestamp < firstCheckBlock.timestamp) {
          firstCheckBlock = checkBlock;
        }
        if (lastCheckBlock === null || checkBlock.timestamp > lastCheckBlock.timestamp) {
          lastCheckBlock = checkBlock;
        }
      }
      return lastCheckBlock.timestamp - firstCheckBlock.timestamp;
    } else {
      return 0;
    }
  })();
  const expectedTimeDiff = TARGET_TIME;
  const averageDifficulty = (() => {
    if (checkBlocks.length > 0) {
      let acc = 0;
      for (let i = 0; i < checkBlocks.length; i++) {
        const checkBlock = checkBlocks[i];
        acc += checkBlock.difficulty;
      }
      return acc / checkBlocks.length;
    } else {
      return 0;
    }
  })();
  const accuracyFactor = Math.max(Math.min(checkBlocksTimeDiff / expectedTimeDiff, TARGET_SWAY_MAX), TARGET_SWAY_MIN);
  const newDifficulty = Math.max(averageDifficulty / accuracyFactor, MIN_DIFFICULTY);
  return newDifficulty;
};
const _getMessagesDifficulty = messages => {
  let result = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    result += _getHashDifficulty(message.hash);
  }
  return result;
};

const crds = opts => new Crds(opts);
module.exports = crds;

if (!module.parent) {
  const args = process.argv.slice(2);
  const _findArg = name => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const match = arg.match(new RegExp('^' + name + '=(.+)$'));
      if (match) {
        return match[1];
      }
    }
    return null;
  };
  const host = _findArg('host') || DEFAULTS.host;
  const port = parseInt(_findArg('port'), 10) || DEFAULTS.port;
  const dataDirectory = _findArg('dataDirectory') || DEFAULTS.dataDirectory;

  const c = new Crds({
    dataDirectory,
  });
  c.listen({
    host,
    port,
  })
    .then(destroy => {
      c.on('exit', () => {
        destroy();
      });

      return c.cli();
    });
}
