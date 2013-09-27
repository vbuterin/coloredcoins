var sx = require('../node-sx'),
    express = require('express'),
    eh = sx.eh,
    _ = require('underscore'),
    mkrespcb = function(res,code,success) { return eh(function(o) { res.json(o,code) },success) }
    coloredcoins = require('./main'),
    seed = 'c356f24f29a795b51a03dc2e30304db0';

var app = express();

app.configure(function(){                                                                 
    app.set('views',__dirname + '/views');                                                  
    app.set('view engine', 'jade'); app.set('view options', { layout: false });             
    app.use(express.bodyParser());                                                          
    app.use(express.methodOverride());                                                      
    app.use(app.router);                                                                    
    app.use(express.static(__dirname + '/public'));                                         
});

app.use('/mkgenesis',function(req,res) {
    var metadata = req.param('metadata'),
        aux = req.param('aux'),
        to = sx.smartParse(req.param('to'));
    coloredcoins.mkgenesis(aux,to,metadata,sx.resjson(res,404,true));
});

app.use('/wallet',function(req,res) {
    var cb = sx.resjson(res,404,true),
        i = parseInt(req.param('i')) || 0;
    sx.genpriv(seed,i,0,eh(cb,function(priv) {
        sx.gen_addr_data(priv,eh(cb,function(addrdata) {
            res.json({ priv: addrdata.priv, address: addrdata.address });
        }));
    }));
});

app.use('/send',function(req,res) {
    console.log(req.query);
    var aux = req.param('aux') || '',
        txout = req.param('txout') || '',
        priv = req.param('priv') || '',
        to = req.param('to') || '',
        metadata = req.param('metadata') || '';
    coloredcoins.send(txout,priv,aux,to,metadata,sx.resjson(res));
});

app.use('/metadata',function(req,res) {
    var tx = req.param('tx') || '';
    coloredcoins.get_metadata(tx,sx.resjson(res));
});

app.use('/genesis',function(req,res) {
    var txout = req.param('txout') || '',
        offset = req.param('offset') || 0;
    coloredcoins.find_genesis(txout,offset,mkrespcb(res,400,_.bind(res.json,res)));
});

app.use('/owner',function(req,res) {
    var genesis = req.param('genesis'),
        txout = req.param('txout'),
        offset = req.param('offset') || 0;
    if (genesis) {
        coloredcoins.find_current_owner(genesis,mkrespcb(res,400,_.bind(res.json,res)));
    }
    else {
        coloredcoins.find_current_owner(txout,offset,mkrespcb(res,400,_.bind(res.json,res)));
    }
});

app.listen(3000);

return app;
