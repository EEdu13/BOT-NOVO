const axios = require('axios');
require('dotenv').config();

// Dados de teste simulando uma mensagem real
const testMessage = `DATA: HOJE
PROJETO: 830
EQUIPE: 830AA
SUPERVISOR: EDUARDO FERREIRA
LÍDER: EDUARDO SILVA
CÓD: LAC005
EMPRESA: LARSIL
SERVIÇO: COMBATE A FORMIGA DIVISAS
FAZENDA: SÃO JOÃO
TALHÃO: 001
AREA REALIZADA: 10
AREA TOTAL: 50
AREA RESTANTE: 40
STATUS TALHÃO: ABERTO
-------------
LOTE/NF:
TIPO:
CLONE:
PLANTADAS:
DESCARTE:
-------------
LOTE1: 1508AB
INSUMO1: FORMICIDA
QUANTIDADE1: 20,50
LOTE2:
INSUMO2:
QUANTIDADE2:
LOTE3:
INSUMO3:
QUANTIDADE3:
-------------
RATEIO PRODUÇÃO MANUAL - (EM BRANCO RATEADO IGUAL)
2508 - 
2509 - 
2510 - 
2308 - 
2108 - 
DIVISÃO DO PREMIO IGUAL: SIM
-------------
EQUIPE APOIO ENVOLVIDA
2689 - PREMIO - VIVEIRO
2608 - 
2609 - 
-------------
ESTRUTURA APOIO ENVOLVIDA
TP001 - 0528 - PREMIO - MOTORISTA
TP009 - 0529
-------------
OBS: Dia chuvoso, terreno molhado`;

async function testBot() {
    try {
        console.log('🧪 Testando Bot Z-API Florestal...\n');
        
        // Teste 1: Health Check
        console.log('1️⃣ Testando Health Check...');
        const healthResponse = await axios.get('http://localhost:3000/');
        console.log('✅ Health Check OK:', healthResponse.data.message);
        
        // Teste 2: Conexão com Banco
        console.log('\n2️⃣ Testando conexão com banco...');
        try {
            const dbResponse = await axios.get('http://localhost:3000/test-db');
            console.log('✅ Banco de dados OK:', dbResponse.data.message);
        } catch (error) {
            console.log('❌ Erro no banco:', error.response?.data?.error || error.message);
        }
        
        // Teste 3: Webhook com mensagem completa
        console.log('\n3️⃣ Testando processamento de mensagem...');
        const webhookData = {
            phone: "5511999999999",
            message: {
                body: testMessage
            }
        };
        
        try {
            const webhookResponse = await axios.post('http://localhost:3000/webhook', webhookData);
            console.log('✅ Webhook processado com sucesso!');
            console.log('📊 Dados extraídos:');
            console.log('   - Projeto:', webhookResponse.data.data.dados_boletim.projeto);
            console.log('   - Fazenda:', webhookResponse.data.data.dados_boletim.fazenda);
            console.log('   - Área Realizada:', webhookResponse.data.data.dados_boletim.area_realizada);
            console.log('   - Colaboradores Rateio:', webhookResponse.data.data.rateio_producao.colaboradores.length);
            console.log('   - Equipe Apoio:', webhookResponse.data.data.equipe_apoio.length);
            console.log('   - Estrutura Apoio:', webhookResponse.data.data.estrutura_apoio.length);
        } catch (error) {
            console.log('❌ Erro no webhook:', error.response?.data?.error || error.message);
        }
        
        console.log('\n🎉 Teste concluído!');
        
    } catch (error) {
        console.error('❌ Erro geral no teste:', error.message);
    }
}

// Executar teste
if (require.main === module) {
    testBot();
}

module.exports = testBot;
