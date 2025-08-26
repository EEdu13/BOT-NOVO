const http = require('http');

console.log('🧪 Testando servidor...');

// Teste simples HTTP
const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/',
    method: 'GET'
};

const req = http.request(options, (res) => {
    console.log(`✅ Status: ${res.statusCode}`);
    
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        try {
            const response = JSON.parse(data);
            console.log('📱 Resposta:', response.message);
            console.log('🕐 Timestamp:', response.timestamp);
            console.log('🎯 Bot funcionando corretamente!');
        } catch (error) {
            console.log('📄 Resposta raw:', data);
        }
    });
});

req.on('error', (error) => {
    console.error('❌ Erro:', error.message);
});

req.end();
