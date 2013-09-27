var sx              = require('../node-sx'),
    eto             = sx.eto,
    express         = require('express'),
    crypto          = require('crypto'),
    async           = require('async'),
    http            = require('http'),
    _               = require('underscore'),
    sha256          = function(x) { return crypto.createHash('sha256').update(x).digest('hex') },
    bitcoind        = require('bitcoin');
    eh              = sx.eh;

var entropy;

crypto.randomBytes(100,function(err,buf) {
    if (err) { throw err; }
    entropy = buf.toString('hex');
});

var client = new bitcoind.Client({
    port: 8000,
    host: '37.139.24.31',
    user: 'bitcoinrpc',
    pass: 'bitcoinpassword'
});

var random = function(modulus) {
    var alphabet = '0123456789abcdef';
    return sha256(entropy+new Date().getTime()+Math.random()).split('')
           .reduce(function(tot,x) {
                return (tot * 16 + alphabet.indexOf(x)) % modulus;
           },0);
}

var binToHex = function(b) {
    if (typeof b == 'string') {
        b = b.split('').map(function(x) { return x.charCodeAt(0) })
    }
    return b.map(function(x) { return (x < 16 ? '0' : '') + x.toString(16) }).join('');
}

var hexToBin = function(s) {
    var out = [];
    for (var i = 0; i < s.length; i += 2) {
        out.push(String.fromCharCode(parseInt(s.substring(i,i+2),16)));
    }
    return out.join('');
}

var m = {}

m.fetchtx = function(tx,cb) {
    var success = _.once(_.partial(cb,null)),
        fail = _.after(2,cb),
        phail = function(x) { console.log('f',x); fail(x); }
    client.getRawTransaction(tx,eh(fail,success));
    sx.blke_fetch_transaction(tx,eh(fail,success));
}

m.sendtx = function(tx,cb) {
    var success = _.once(_.partial(null,cb)),
        fail = _.after(3,cb),
        phail = function(x) { console.log('f',x); fail(x); }
    client.sendRawTransaction(tx,eh(fail,success));
    sx.bci_pushtx(tx,eh(fail,success));
    sx.electrum_pushtx(tx,eh(fail,success));
}


// Format
// output 0-(n-1): addresses for colored coins
// output n: 1111111111111111111114oLvT2
// output n+1+: metadata

m.mkgenesis = function(priv, addresses, metadata, cb) {
    if (typeof addresses == 'string') {
        addresses = [addresses];
    }
    var t = {};
    async.waterfall([
        // Get list of outputs
        function(cb2) {
            // Start off with given output addresses
            var outputs = addresses.map(function(a) { 
                return { address: a, value: 10000 }
            }).concat([
                // Zero address to indentify genesis transactions
                { address: '1111111111111111111114oLvT2', value: 10000 }
            ]);
            // Encode metadata into hash160s
            var ms = [];
            for (var pos = 0; pos < metadata.length; pos += 20) {
                var mstr = metadata.substring(pos,pos+20);
                while (mstr.length < 20) mstr += '\x00';
                ms.push(mstr);
            }
            // Convert hash160s into addresses
            sx.cbmap(ms,function(m,cb3) {
                sx.base58check_encode(binToHex(m),0,cb3);
            },eh(cb,function(maddrs) {
                outputs = outputs.concat(maddrs.map(function(x) {
                    return { address: x, value: 10000 }
                }));
                cb2(null,outputs);
            }));
        },
        // Generate address from private key
        function(outputs,cb2) {
            console.log(outputs);
            sx.addr(priv,eh(cb2,function(from) { cb2(null,outputs,from) }))
        },
        // Make a transaction, ensuring that fee = 0.0001 * ceil(txsize / 1024 bytes)
        function(outputs,from,cb2) {
            sx.bci_history(from,eh(cb2,function(h) {
                sx.send_to_outputs(h,outputs,0,eh(cb2,function(o) {
                    sx.showtx(o.tx,eh(cb2,function(txobj) {
                        cb2(null,o.utxo,o.tx,txobj);
                    }));
                }));
            }));
        },
        // Sign and broadcast
        function(utxo,tx,txobj,cb2) {
            console.log('signing');
            sx.sign_tx_inputs(tx,priv,utxo,eh(cb2,function(tx) {
                m.sendtx(tx,cb2);
                cb2(null,txobj);
            }));
        }
    ],cb);
}

// txin -> txout that spent it
m.get_prevout = function(txin,cb) {
    // Coinbase transaction
    if (/^0{64}/.exec(txin.prev)) {
        return cb("Coinbase");
    }
    console.log('t',txin);
    m.fetchtx(txin.prev.substring(0,64),eh(cb,function(tx) {
        console.log('t',tx);
        sx.showtx(tx,eh(cb,function(txobj) {
            cb(null,txobj.outputs[parseInt(txin.prev.substring(65))]);
        }));
    }));
}

// Vertical flow algorithm for tracking colored coins
m.get_parent_helper = function(txobj,index,offset,cb) {
    var in_index = 0;
    console.log('q');
    // Get previous outputs of all inputs
    sx.cbmap(txobj.inputs, m.get_prevout, eh(cb,function(prevtxobjs) {
        if (prevtxobjs[0] == "Coinbase") {
            return cb(null,null,null,null); //Coinbase
        }
        var offset = txobj.outputs.slice(0,index)
                          .map(sx.getter('value'))
                          .reduce(sx.add,0) + offset;
        while (offset > prevtxobjs[in_index].value) {
            offset -= prevtxobjs[in_index].value;
            in_index++;
        }
        console.log('p',prevtxobjs[in_index],in_index,offset)
        cb(null,prevtxobjs[in_index],in_index,offset)
    }));
}

// txobj:outindex -> child txobj:inindex
m.get_spender = function(txobj,index,cb) {
    sx.bci_history(txobj[index].address,eh(cb,function(h) {
        var o = h.filter(function(x) { x.output == txobj.hash+':'+index })[0];
        if (!o) return cb("Transaction not found");
        if (!o.spend) return cb(null,null) // Transaction unspent
        m.fetchtx(o.spend.substring(0,64),eh(cb,function(next_txobj) {    
            return cb(null,{
                txobj: next_txobj,
                index: parseInt(o.spend.substring(65)) 
            })
        }));
    }));
}

// inverse function of get_parent_helper
m.get_child_helper = function(txobj,index,offset,cb) {
    m.get_spender(txobj,index,eh(cb,function(o) {
        sx.cbmap(o.next_txobj.inputs,get_prevout,eh(cb,function(prevouts) {
            var offset = prevouts.slice(0,o.index)
                                  .map(sx.getter('values'))
                                  .reduce(sx.add,0) + offset;
            var out_index = 0;
            while (offset > prevouts[out_index].value) {
                offset -= prevous[out_index].value;
                out_index++;
                if (out_index >= prevouts.length) {
                    return cb(null,"Transaction fee"); //I became a transaction fee!
                }
            }
            out_index--;
            return cb(null,o.next_txobj,out_index,offset);
        }));
    }));
}

// Get the genesis transaction of a given txobj, index and offset
m.find_genesis_helper = function(txobj,index,offset,cb) {
    m.get_parent_helper(txobj,index,offset,eh(cb,function(prevtxobj,previndex,prevoffset) {
        if (!prevtxobj) {
            cb("Reached coinbase, no genesis found");
        }
        else {
            console.log('r');
            var genesis_zeroaddr_pos = -1;
            for (var i = 0; i < prevtxobj.outputs.length; i++) {
                if (prevtxobj.outputs[i].address == "1111111111111111111114oLvT2") {
                    genesis_zeroaddr_pos = i;
                }
            }
            if (genesis_zeroaddr_pos >= 0 && previndex < genesis_zeroaddr_pos) {
                return cb(null,prevtxobj,previndex,prevoffset);
            }
            find_genesis_helper(prevtxobj,previndex,prevoffset,cb);
        }
    }));
}

// Get the genesis transaction of a given txhash:index and offset
m.find_genesis = function(txout,offset,cb) {
    m.fetchtx(txout.substring(0,64),eh(cb,function(tx) {
        sx.showtx(tx,eh(cb,function(txobj) {
            m.find_genesis_helper(txobj,parseInt(txout.substring(65)),offset,eh(cb,function(txobj,index,offset) {
                return cb(null,txobj.hash+':'+index);
            }));
        }));
    }));
}

// Get the current owner of the coin at a given txobj, index and offset
m.find_current_owner_helper = function(txobj,index,offset,cb) {
    m.get_child_helper(txobj,index,offset,eh(cb,function(nexttxobj,nextindex,nextoffset) {
        if (!nexttxobj) {
            if (!nextindex) cb(null,txobj,index,offset)
        }
        else if (nexttxobj == "Transaction fee") cb(null,"Transaction fee");
        else find_current_owner_helper(nexttxobj,nextindex,nextoffset,cb);
    }));
}

// Get the current owner of a given txhash:index and offset or genesis txhash
// Polymorphism or matchers would really help here, but oh well, javascript is awesome
// as it is so let's no screw it up
m.find_current_owner = function() {
    var txhash, index = 0, offset = 0, cb;
    if (typeof arguments[1] == "function") {
        txhash = arguments[0];
        cb = arguments[1];
    }
    else {
        txhash = arguments[0].substring(0,64);
        index = parseInt(arguments[0].substring(65));
        offset = parseInt(arguments[1]);
        cb = arguments[2];
    }
    var t = {};
    async.waterfall([function(cb2) {
        m.fetchtx(txhash,sx.cbsetter(t,'tx',cb2));
    }, function(_,cb2) {
        sx.showtx(t.tx,sx.cbsetter(t,'txobj',cb2));
    }, function(_,cb2) {
        find_current_owner_helper(t.txobj,index,offset,eh(cb,function(txobj,index,offset) {
            if (txobj == "Transaction fee") {
                return cb2("I became a transaction fee!"); //People should really start using this as a euphemism for things
            }
            return cb2(null,{
                txout: txobj.hash+':'+index,
                offset: offset,
                address: txobj.outputs[index].address
            });
        }));
    }],cb);
}

m.get_metadata = function(tx,cb) {
    if (tx.length == 64) {
        return m.fetchtx(tx,eh(cb,function(txfull) { 
            m.get_metadata(txfull,cb) 
        }));
    }
    sx.showtx(tx,eh(cb,function(txobj) {
        var outaddrs = txobj.outputs.map(sx.getter('address')),
            zeropos = outaddrs.indexOf('1111111111111111111114oLvT2');
        if (zeropos == -1) return cb("No metadata");
        else sx.cbmap(outaddrs.slice(zeropos+1),sx.decode_addr,eh(cb,function(hash160s) {
            cb(null,hash160s.map(hexToBin).join(''));
        }));
    }));
}

// Send (empty everything in a privkey)
m.send = function(txout,priv,auxpriv,to,metadata,cb) {
    var t = {};
    // Fetch transaction txout
    async.waterfall([function(cb2) {
        m.fetchtx(txout.substring(0,64),sx.cbsetter(t,'tx',cb2));
    },function(_,cb2) {
        sx.showtx(t.tx,sx.cbsetter(t,'txobj',cb2));
    },function(_,cb2) {
        sx.addr(priv,sx.cbsetter(t,'fromaddress',cb2));
    },function(_,cb2) {
        if (auxpriv) sx.addr(auxpriv,sx.cbsetter(t,'auxaddress',cb2));
        else cb2();
    },function(_,cb2) {
        console.log(5);
        var me = [{
            output: txout,
            value: t.txobj.outputs[parseInt(txout.substring(65))].value,
            address: t.fromaddress
        }];
        if (auxpriv) {
            sx.bci_history(t.auxaddress,eh(cb2,function(h) {
                var utxo = h.filter(function(x) { return !x.spend });
                sx.cbsetter(t,'utxo',cb2)(null,me.concat(sx.txodiff(utxo,me)));
            }));
        }
        else sx.cbsetter(t,'utxo',cb2)(null,me);
    },function(_,cb2) {
        console.log(7);
        ms = [];
        for (var pos = 0; pos < metadata.length; pos += 20) {
            var mstr = metadata.substring(pos,pos+20);
            while (mstr.length < 20) mstr += '\x00';
            ms.push(mstr);
        }
        sx.cbmap(ms,function(m,cb3) {
            sx.base58check_encode(binToHex(m),0,cb3);
        },eh(cb2,function(addrs) {
            t.outs = [{ address: to, value: 10000 }]
                     .concat(addrs.map(function(a) {
                        return { address: a, value: 10000 }
                     }));
            sx.mktx(t.utxo,t.outs,sx.cbsetter(t,'testtx',cb2))
        }));
    },function(_,cb2) {
        var in_value = t.utxo.map(sx.getter('value')).reduce(sx.plus,0),
            out_value = t.outs.map(sx.getter('value')).reduce(sx.plus,0),
            fee = Math.ceil(t.testtx.length / 2048) * 10000;
        if (in_value < out_value + fee) {
            return cb2("Not enough funds to pay fee");
        }
        else {
            t.outs[0].value += in_value - out_value - fee;
            console.log(t.utxo,t.outs);
            sx.mktx(t.utxo,t.outs,sx.cbsetter(t,'tx',cb2));
        }
    },function(_,cb2) {
        var privs = auxpriv ? [priv,auxpriv] : [priv];
        sx.sign_tx_inputs(t.tx,privs,t.utxo,sx.cbsetter(t,'newtx',cb2));
    },function(_,cb2) {
        console.log(t.newtx);
        sx.showtx(t.newtx,sx.cbsetter(t,'newtxobj',cb2));
    },function(_,cb2) {
        var fail = cb2;
        var success = function(r) { cb2(null, { response: r, tx: t.newtxobj }) };
        m.sendtx(t.newtx,eh(fail,success));
    }],cb);
}

module.exports = m;
