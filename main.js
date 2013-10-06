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

m.debugmode = 0;

m.log = function(msg1, msg2, etc, priority) {
    var priority = arguments[arguments.length-1],
        msgs = Array.prototype.slice.call(arguments,0,arguments.length-1);
    if (m.debugmode >= priority) console.log.apply(console, msgs);
}

// Format
// output 0-(n-1): addresses for colored coins
// output n: 1111111111111111111114oLvT2
// output n+1+: metadata

m.mkgenesis = function(h, addresses, metadata, cb) {
    if (typeof addresses == 'string') {
        addresses = [addresses];
    }
    var t = {};
    async.waterfall([
        // Get list of outputs
        function(cb2) {
            // Start off with given output addresses
            m.log("Making genesis",1);
            var outputs = addresses.map(function(a) { 
                return { address: a, value: 10000 }
            }).concat([
                // Zero address to indentify genesis transactions
                { address: '1111111111111111111114oLvT2', value: 10000 }
            ]);
            m.log("outputs",outputs,2);
            console.log("Generating outputs");
            // Encode metadata into hash160s
            var ms = [];
            for (var pos = 0; pos < metadata.length; pos += 20) {
                var mstr = metadata.substring(pos,pos+20);
                while (mstr.length < 20) mstr += '\x00';
                ms.push(mstr);
            }
            m.log("metadata",ms,2);
            // Convert hash160s into addresses
            async.map(ms,function(m,cb3) {
                sx.base58check_encode(binToHex(m),0,cb3);
            },eh(cb2,function(maddrs) {
                m.log("metadata addresses",maddrs,3);
                outputs = outputs.concat(maddrs.map(function(x) {
                    return { address: x, value: 10000 }
                }))
                .concat({ address: t.from, value: 10000 }); // Change address (mandatory)
                sx.cbsetter(t,'outputs',cb2)(null,outputs);
            }));
        },
        // Make a transaction, ensuring that fee = 0.0001 * ceil(txsize / 1024 bytes)
        function(__,cb2) {
            m.log("Constructing transaction",2);
            sx.send_to_outputs(h,t.outputs,t.outputs.length-1,cb2);
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
    async.map(txobj.inputs, m.get_prevout, eh(cb,function(prevtxobjs) {
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
        async.map(o.next_txobj.inputs,get_prevout,eh(cb,function(prevouts) {
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
        else async.map(outaddrs.slice(zeropos+1),sx.decode_addr,eh(cb,function(hash160s) {
            cb(null,hash160s.map(hexToBin).join(''));
        }));
    }));
}

// Send (empty everything in a privkey)
m.mksend = function(txout,aux,to,change,metadata,cb) {
    var scope = {};
    // Fetch transaction txout
    async.waterfall([function(cb2) {
        m.log("Generating sending transaction",1);
        // txhash:index format
        if (typeof txout == "string") {
            m.fetchtx(txout.substring(0,64),eh(cb2,function(tx) {
                sx.showtx(tx,eh(cb2,function(txobj) {
                    scope.spendee = txobj.outputs[parseInt(txout.substring(65))].value;
                    cb2(null,true);
                }));
            }));
        }
        // txout format
        else { scope.spendee = txout; }
    },function(_,cb2) {
        ms = [];
        for (var pos = 0; pos < metadata.length; pos += 20) {
            var mstr = metadata.substring(pos,pos+20);
            while (mstr.length < 20) mstr += '\x00';
            ms.push(mstr);
        }
        m.log("Metadata:",ms,3);
        async.map(ms,function(m,cb3) {
            sx.base58check_encode(binToHex(m),0,cb3);
        },eh(cb2,function(addrs) {
            m.log("Metadata addresses:",maddrs,2);
            scope.outputs = [{ address: to, value: 10000 },
                             { address: t.auxaddress, value: 10000 }]
                            .concat(addrs.map(function(a) {
                                return { address: a, value: 10000 }
                            }));
            cb2();
        }));
    },function(cb2) {
        // Try to make a transaction with the desired output set. Sometimes,
        // that stransaction might be large enough to warrant a fee above
        // 0.0001 BTC, in which case we might need to bring in more inputs
        // to cover the full amount, so all in all we might need to increase
        // the size of the transaction several times
        var fee_multiplier = 1,
            fee,
            out_value = scope.outputs.map(m.getter('value')).reduce(m.plus,0);
        sx.cbuntil(function(cb2) {
            fee = fee_multiplier * 10000;
            m.get_enough_utxo_from_history(h,out_value + fee,eh(cb2,function(utxo) {
                scope.inputs = scope.spendee.concat(utxo);
                m.mktx(scope.inputs,scope.outputs,eh(cb2,function(tx) {
                    scope.testtx = tx;
                    if (Math.ceil((tx.length+2) / 2048) > fee_multiplier) {
                        console.log(fee_multiplier);
                        fee_multiplier = Math.ceil(tx.length / 2048);
                        return cb2(null,false);
                    }
                    return cb2(null,true);
                }));
            }));    
        },cb2);
    },function(_,cb2) {
        // Create a new transaction just like the successful one but with
        // the extra funds redirected to the change address
        var in_value = scope.inputs.map(sx.getter('value')).reduce(sx.plus,0),
            out_value = scope.outputs.map(sx.getter('value')).reduce(sx.plus,0),
            fee = Math.ceil(t.testtx.length / 2048) * 10000;
        if (in_value < out_value + fee) {
            return cb2("Not enough funds to pay fee");
        }
        else {
            scope.outputs[1].value += in_value - out_value - fee;
            m.log("Making tx with inputs and outputs:",scope.inputs,scope.outs,2);
            sx.mktx(scope.inputs,scope.outputs,sx.cbsetter(scope,'tx',cb2));
        }

    }],eh(cb,function() { cb(null,{tx: scope.tx, utxo: scope.utxo}) }));
}

module.exports = m;
