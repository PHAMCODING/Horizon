const https = require('https');
const fs = require('fs');
const path = require('path');

const mime = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.json': 'application/json'
};

const options = {
    pfx: fs.readFileSync(path.join(__dirname, 'cert.pfx')),
    passphrase: 'password'
};

const srv = https.createServer(options, (req, res) => {
    let f = req.url === '/' ? '/index.html' : req.url;
    let fp = path.join(__dirname, f);
    
    fs.readFile(fp, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': mime[path.extname(fp)] || 'text/plain',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(data);
    });
});

srv.listen(443, () => {
    console.log('Secure server running at https://horizonofflineai.ca (or https://localhost)');
});
