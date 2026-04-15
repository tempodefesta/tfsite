const fs = require('fs');
const { execSync } = require('child_process');

const ca = fs.readFileSync('ca-cert.pem', 'utf8');
const clientCert = fs.readFileSync('client-cert.pem', 'utf8');
const clientKey = fs.readFileSync('client-key.pem', 'utf8');

const envVars = {
    ...process.env
};

function setSecret(name, value) {
    // Escrito no .env local primeiro que npx supabase secrets set --env-file le automático
    fs.writeFileSync('.env.secrets.tmp', `${name}="${value.replace(/\n/g, '\\n')}"\n`);
    try {
        console.log(execSync(`npx supabase secrets set --env-file .env.secrets.tmp`, { env: envVars, encoding: 'utf8' }));
    } catch (e) {
        console.error(e.stdout, e.stderr);
    }
}

setSecret('VANE_CA_CERT', ca);
setSecret('VANE_CLIENT_CERT', clientCert);
setSecret('VANE_CLIENT_KEY', clientKey);

fs.unlinkSync('.env.secrets.tmp');
console.log("Secrets upload finished.");
