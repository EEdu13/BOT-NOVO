const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');
const sql = require('mssql');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuração OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Armazenar boletins pendentes de aprovação (em produção usar Redis ou banco)
const boletisPendentes = new Map();

// Configuração Azure SQL Database
const dbConfig = {
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
        encrypt: true,
        trustServerCertificate: false
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// Configuração Z-API
const zapiConfig = {
    instanceId: process.env.ZAPI_INSTANCE_ID,
    token: process.env.ZAPI_TOKEN,
    clientToken: process.env.ZAPI_CLIENT_TOKEN,
    baseUrl: process.env.ZAPI_BASE_URL
};

// Função para enviar mensagem via Z-API
async function sendWhatsAppMessage(phone, message) {
    try {
        const url = `${zapiConfig.baseUrl}/${zapiConfig.instanceId}/token/${zapiConfig.token}/send-text`;
        console.log('🔗 URL Z-API:', url);
        
        const payload = {
            phone: phone,
            message: message
        };
        
        console.log('📤 Payload:', JSON.stringify(payload, null, 2));
        
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Client-Token': zapiConfig.clientToken
            },
            timeout: 10000
        });
        
        console.log('✅ Resposta Z-API:', response.data);
        return response.data;
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem Z-API:', error.response?.data || error.message);
        throw error;
    }
}

// Função para processar mensagem com OpenAI
async function processMessageWithAI(message) {
    try {
        const prompt = `
        Você é um assistente especializado em extrair dados de boletins diários florestais.
        
        Analise a mensagem abaixo e extraia TODOS os dados no formato JSON exato:
        
        {
            "tipo": "boletim_diario",
            "dados_boletim": {
                "data": "YYYY-MM-DD",
                "projeto": "string",
                "equipe": "string",
                "supervisor": "string", 
                "lider": "string",
                "cod": "string",
                "empresa": "string",
                "servico": "string",
                "fazenda": "string",
                "talhao": "string",
                "area_realizada": number,
                "area_total": number,
                "area_restante": number,
                "status_talhao": "string",
                "lote_nf": "string",
                "tipo": "string",
                "clone": "string",
                "plantadas": number,
                "descarte": number,
                "insumos": [
                    {"lote": "string", "insumo": "string", "quantidade": number}
                ],
                "observacao": "string"
            },
            "rateio_producao": {
                "colaboradores": ["2508", "2509", "2510", "2308", "2108"],
                "valores": [2, 0, 0, 0, 0],
                "divisao_igual": "SIM"
            },
            "equipe_apoio": [
                {"registro": "2689", "premio": "SIM", "classe": "VIVEIRO", "valor": 30.00},
                {"registro": "2608", "premio": "NAO", "classe": "", "valor": 0},
                {"registro": "2609", "premio": "NAO", "classe": "", "valor": 0}
            ],
            "estrutura_apoio": [
                {"prefixo": "TP001", "registro": "0528", "premio": "SIM", "classe": "MOTORISTA", "valor": 30.00},
                {"prefixo": "TP009", "registro": "0529", "premio": "NAO", "classe": "", "valor": 0}
            ]
        }
        
        REGRAS IMPORTANTES:
        - Se "HOJE" na data, use a data atual
        - Se DIVISÃO DO PREMIO IGUAL = SIM, divida area_realizada igualmente
        - Se DIVISÃO DO PREMIO IGUAL = NAO, use valores específicos após os traços
        - Se há "PREMIO" no texto, premio = "SIM" e valor = 30.00
        - Se vazio após traço, valor = 0
        
        Mensagem para analisar:
        ${message}
        
        Responda APENAS com o JSON, sem explicações.
        `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1
        });

        return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.error('Erro ao processar com OpenAI:', error.message);
        throw error;
    }
}

// Função para inserir dados no banco
async function insertDataToDatabase(extractedData) {
    let pool;
    try {
        pool = await sql.connect(dbConfig);
        
        // 1. Inserir na tabela BOLETIM_DIARIO_COPY
        const boletimQuery = `
            INSERT INTO BOLETIM_DIARIO_COPY (
                DATA_EXECUÇÃO, PROJETO, LÍDER, SUPERVISOR, NOME_DO_LIDER, 
                COD, EMPRESA, SERVIÇO, FAZENDA, TALHAO, PRODUÇÃO, STATUS,
                TIPO, CLONE, PLANTADAS, DESCARTE, LOTE1, INSUMO1, QUANTIDADE1,
                LOTE2, INSUMO2, QUANTIDADE2, LOTE3, INSUMO3, QUANTIDADE3,
                OBSERVAÇÃO, CRIADO, CRIADO_POR, MODIFICADO, MODIFICADO_POR
            ) VALUES (
                @data, @projeto, @equipe, @supervisor, @lider,
                @cod, @empresa, @servico, @fazenda, @talhao, @area_realizada, @status,
                @tipo, @clone, @plantadas, @descarte, @lote1, @insumo1, @quantidade1,
                @lote2, @insumo2, @quantidade2, @lote3, @insumo3, @quantidade3,
                @observacao, GETDATE(), 'BOT_ZAPI', GETDATE(), 'BOT_ZAPI'
            )
        `;

        const boletimRequest = pool.request();
        const dados = extractedData.dados_boletim;
        
        boletimRequest.input('data', sql.DateTime, new Date(dados.data));
        boletimRequest.input('projeto', sql.VarChar, dados.projeto);
        boletimRequest.input('equipe', sql.VarChar, dados.equipe);
        boletimRequest.input('supervisor', sql.VarChar, dados.supervisor);
        boletimRequest.input('lider', sql.VarChar, dados.lider);
        boletimRequest.input('cod', sql.VarChar, dados.cod);
        boletimRequest.input('empresa', sql.VarChar, dados.empresa);
        boletimRequest.input('servico', sql.VarChar, dados.servico);
        boletimRequest.input('fazenda', sql.VarChar, dados.fazenda);
        boletimRequest.input('talhao', sql.VarChar, dados.talhao);
        boletimRequest.input('area_realizada', sql.Decimal, dados.area_realizada);
        boletimRequest.input('status', sql.VarChar, dados.status_talhao);
        boletimRequest.input('tipo', sql.VarChar, dados.tipo || '');
        boletimRequest.input('clone', sql.VarChar, dados.clone || '');
        boletimRequest.input('plantadas', sql.Decimal, dados.plantadas || 0);
        boletimRequest.input('descarte', sql.Decimal, dados.descarte || 0);
        
        // Insumos
        const insumos = dados.insumos || [];
        boletimRequest.input('lote1', sql.VarChar, insumos[0]?.lote || '');
        boletimRequest.input('insumo1', sql.VarChar, insumos[0]?.insumo || '');
        boletimRequest.input('quantidade1', sql.Decimal, insumos[0]?.quantidade || 0);
        boletimRequest.input('lote2', sql.VarChar, insumos[1]?.lote || '');
        boletimRequest.input('insumo2', sql.VarChar, insumos[1]?.insumo || '');
        boletimRequest.input('quantidade2', sql.Decimal, insumos[1]?.quantidade || 0);
        boletimRequest.input('lote3', sql.VarChar, insumos[2]?.lote || '');
        boletimRequest.input('insumo3', sql.VarChar, insumos[2]?.insumo || '');
        boletimRequest.input('quantidade3', sql.Decimal, insumos[2]?.quantidade || 0);
        boletimRequest.input('observacao', sql.VarChar, dados.observacao || '');

        await boletimRequest.query(boletimQuery);
        
        // Pegar o ID do boletim inserido para usar como RAW nos prêmios
        const boletimIdResult = await pool.request().query('SELECT TOP 1 ID FROM BOLETIM_DIARIO_COPY ORDER BY ID DESC');
        const boletimId = boletimIdResult.recordset[0]?.ID;
        console.log('🆔 ID do boletim inserido:', boletimId);

        // 2. Inserir registros na tabela PREMIO_COPY
        const premioQuery = `
            INSERT INTO PREMIO_COPY (
                RAW, DATA, PROJETO, SUPERVISOR, REGISTRO, COLABORADOR, ATIVIDADE_EXECUTADA,
                PRODUCAO_DO_DIA, CLASSE, VALOR_POR_HECTARE, PREFIXO,
                CRIADO, CRIADO_POR, MODIFICADO, MODIFICADO_POR
            ) VALUES (
                @RAW, @data, @projeto, @supervisor, @registro, @colaborador, @atividade,
                @producao, @classe, @valor, @prefixo,
                GETDATE(), 'BOT_ZAPI', GETDATE(), 'BOT_ZAPI'
            )
        `;

        // Inserir rateio de produção
        const rateio = extractedData.rateio_producao;
        console.log('📊 Inserindo rateio de produção para', rateio.colaboradores.length, 'colaboradores...');
        
        // Calcular valor por colaborador (área realizada dividida igualmente)
        const areaRealizada = parseFloat(dados.area_realizada) || 0;
        const valorPorColaborador = areaRealizada / rateio.colaboradores.length;
        
        console.log(`📊 Área realizada: ${areaRealizada}, Valor por colaborador: ${valorPorColaborador}`);
        
        for (let i = 0; i < rateio.colaboradores.length; i++) {
            if (rateio.colaboradores[i] && rateio.colaboradores[i].trim() !== '') {
                console.log(`   - Colaborador ${i + 1}: ${rateio.colaboradores[i]} = ${valorPorColaborador}`);
                const request = pool.request();
                request.input('RAW', sql.BigInt, boletimId); // Conectar com o boletim
                request.input('data', sql.DateTime, new Date(dados.data));
                request.input('projeto', sql.VarChar, dados.projeto);
                request.input('supervisor', sql.VarChar, dados.supervisor);
                request.input('registro', sql.VarChar, rateio.colaboradores[i]);
                request.input('colaborador', sql.VarChar, ''); // Auto-preenchido
                request.input('atividade', sql.VarChar, dados.servico);
                request.input('producao', sql.Decimal, valorPorColaborador);
                request.input('classe', sql.VarChar, '');
                request.input('valor', sql.Decimal, 0);
                request.input('prefixo', sql.VarChar, '');
                
                await request.query(premioQuery);
            }
        }

        // Inserir equipe de apoio
        for (const apoio of extractedData.equipe_apoio) {
            if (apoio.registro) {
                const request = pool.request();
                request.input('RAW', sql.BigInt, boletimId); // Conectar com o boletim
                request.input('data', sql.DateTime, new Date(dados.data));
                request.input('projeto', sql.VarChar, dados.projeto);
                request.input('supervisor', sql.VarChar, dados.supervisor);
                request.input('registro', sql.VarChar, apoio.registro);
                request.input('colaborador', sql.VarChar, '');
                request.input('atividade', sql.VarChar, dados.servico);
                request.input('producao', sql.Decimal, 0);
                request.input('classe', sql.VarChar, apoio.classe);
                request.input('valor', sql.Decimal, apoio.valor);
                request.input('prefixo', sql.VarChar, '');
                
                await request.query(premioQuery);
            }
        }

        // Inserir estrutura de apoio
        for (const estrutura of extractedData.estrutura_apoio) {
            if (estrutura.registro) {
                const request = pool.request();
                request.input('RAW', sql.BigInt, boletimId); // Conectar com o boletim
                request.input('data', sql.DateTime, new Date(dados.data));
                request.input('projeto', sql.VarChar, dados.projeto);
                request.input('supervisor', sql.VarChar, dados.supervisor);
                request.input('registro', sql.VarChar, estrutura.registro);
                request.input('colaborador', sql.VarChar, '');
                request.input('atividade', sql.VarChar, dados.servico);
                request.input('producao', sql.Decimal, 0);
                request.input('classe', sql.VarChar, estrutura.classe);
                request.input('valor', sql.Decimal, estrutura.valor);
                request.input('prefixo', sql.VarChar, estrutura.prefixo);
                
                await request.query(premioQuery);
            }
        }

        return { success: true, message: 'Dados inseridos com sucesso!', boletimId: boletimId };
        
    } catch (error) {
        console.error('Erro ao inserir no banco:', error.message);
        throw error;
    } finally {
        if (pool) {
            await pool.close();
        }
    }
}

// Função para buscar coordenador do projeto
async function getCoordenadorProjeto(projeto) {
    try {
        const pool = sql.pool || await sql.connect(dbConfig);
        const result = await pool.request()
            .input('projeto', sql.VarChar, projeto)
            .query(`
                SELECT USUARIO, TELEFONE, PERFIL 
                FROM USUARIOS 
                WHERE PROJETO = @projeto AND PERFIL = 'COORDENADOR'
            `);
        
        if (result.recordset.length > 0) {
            return result.recordset[0];
        }
        return null;
    } catch (error) {
        console.error('❌ Erro ao buscar coordenador:', error.message);
        return null;
    }
}

// Função para formatar mensagem de aprovação
function formatarMensagemAprovacao(extractedData, telefoneOriginal, boletimId, boletimDbId) {
    const dados = extractedData.dados_boletim;
    const rateio = extractedData.rateio_producao;
    
    let mensagem = `🔍 *APROVAÇÃO DE BOLETIM*\n\n`;
    mensagem += `🆔 *ID Boletim:* ${boletimId}\n`;
    mensagem += `🏛️ *ID Banco:* ${boletimDbId}\n`;
    mensagem += `📱 *Enviado por:* ${telefoneOriginal}\n`;
    mensagem += `📅 *Data:* ${dados.data}\n`;
    mensagem += `🏗️ *Projeto:* ${dados.projeto}\n`;
    mensagem += `👨‍💼 *Supervisor:* ${dados.supervisor}\n`;
    mensagem += `🚜 *Serviço:* ${dados.servico}\n`;
    mensagem += `🌱 *Fazenda:* ${dados.fazenda}\n`;
    mensagem += `📏 *Área Realizada:* ${dados.area_realizada}\n\n`;
    
    mensagem += `👥 *Colaboradores (${rateio.colaboradores.length}):*\n`;
    rateio.colaboradores.forEach((collab, i) => {
        mensagem += `• ${collab}\n`;
    });
    
    if (extractedData.equipe_apoio.length > 0) {
        mensagem += `\n🤝 *Equipe Apoio:*\n`;
        extractedData.equipe_apoio.forEach(apoio => {
            mensagem += `• ${apoio.registro} - ${apoio.classe}\n`;
        });
    }
    
    if (dados.observacoes) {
        mensagem += `\n📝 *Obs:* ${dados.observacoes}\n`;
    }
    
    mensagem += `\n*Responda:*\n`;
    mensagem += `*1* - APROVAR\n`;
    mensagem += `*2* - CORRIGIR (+ observação)`;
    
    return mensagem;
}

// Função para processar aprovação
async function processarAprovacao(phone, messageText, res) {
    try {
        console.log('🔍 Processando aprovação...');
        console.log('📱 Telefone original:', phone);
        
        // Normalizar telefone (usar apenas números)
        const telefoneNormalizado = phone.replace(/[^\d]/g, '');
        console.log('📱 Telefone normalizado:', telefoneNormalizado);
        console.log('🗂️ Boletins pendentes:', Array.from(boletisPendentes.keys()));
        
        const boletimPendente = boletisPendentes.get(telefoneNormalizado);
        
        if (!boletimPendente) {
            console.log('❌ Boletim não encontrado para telefone:', telefoneNormalizado);
            await sendWhatsAppMessage(phone, "❌ Nenhum boletim pendente encontrado para aprovação.");
            return res.status(200).json({ success: true });
        }
        
        // Atualizar banco de dados - marcar como aprovado
        await atualizarStatusBoletim(boletimPendente.boletimDbId, 'APROVADO', phone);
        
        // Remover da lista de pendentes
        boletisPendentes.delete(telefoneNormalizado);
        
        // Enviar aprovação para o funcionário
        const mensagemAprovacao = `✅ *BOLETIM APROVADO!*

🆔 *ID Boletim:* ${boletimPendente.id}
🏛️ *ID Banco:* ${boletimPendente.boletimDbId}
👨‍💼 Aprovado por: Coordenador
📅 Data: ${new Date().toLocaleString('pt-BR')}

📊 *Resumo do Boletim:*
• Projeto: ${boletimPendente.extractedData.dados_boletim.projeto}
• Fazenda: ${boletimPendente.extractedData.dados_boletim.fazenda}
• Área Realizada: ${boletimPendente.extractedData.dados_boletim.area_realizada}

💾 Dados confirmados no sistema!`;

        await sendWhatsAppMessage(boletimPendente.telefoneOriginal, mensagemAprovacao);
        
        // Confirmar para o coordenador
        await sendWhatsAppMessage(phone, `✅ Boletim aprovado com sucesso! Funcionário foi notificado.\n\n🆔 *ID Boletim:* ${boletimPendente.id}\n🏛️ *ID Banco:* ${boletimPendente.boletimDbId}`);
        
        return res.status(200).json({ success: true });
        
    } catch (error) {
        console.error('Erro ao processar aprovação:', error);
        await sendWhatsAppMessage(phone, "❌ Erro ao processar aprovação. Tente novamente.");
        return res.status(500).json({ error: error.message });
    }
}

// Função para atualizar status do boletim no banco
async function atualizarStatusBoletim(boletimId, status, aprovadoPor) {
    try {
        const pool = sql.pool || await sql.connect(dbConfig);
        await pool.request()
            .input('id', sql.BigInt, boletimId)
            .input('status', sql.VarChar, status)
            .input('aprovadoPor', sql.VarChar, aprovadoPor)
            .query(`
                UPDATE BOLETIM_DIARIO_COPY 
                SET APROVADO_POR = @aprovadoPor
                WHERE ID = @id
            `);
        
        console.log(`✅ Boletim ${boletimId} atualizado: ${status} por ${aprovadoPor}`);
    } catch (error) {
        console.error('❌ Erro ao atualizar status do boletim:', error.message);
        throw error;
    }
}

// Função para processar correção
async function processarCorrecao(phone, messageText, res) {
    try {
        // Normalizar telefone (usar apenas números)
        const telefoneNormalizado = phone.replace(/[^\d]/g, '');
        
        const boletimPendente = boletisPendentes.get(telefoneNormalizado);
        
        if (!boletimPendente) {
            await sendWhatsAppMessage(phone, "❌ Nenhum boletim pendente encontrado para correção.");
            return res.status(200).json({ success: true });
        }
        
        // Extrair observação (tudo após "2 - CORRIGIR")
        const observacao = messageText.replace(/^2\s*-?\s*CORRIGIR\s*/i, '').trim();
        
        // Atualizar banco de dados - marcar como rejeitado
        await atualizarStatusBoletim(boletimPendente.boletimDbId, 'REJEITADO', phone);
        
        // Remover da lista de pendentes
        boletisPendentes.delete(telefoneNormalizado);
        
        // Enviar solicitação de correção para o funcionário
        const mensagemCorrecao = `🔄 *CORREÇÃO SOLICITADA*

🆔 *ID Boletim:* ${boletimPendente.id}
🏛️ *ID Banco:* ${boletimPendente.boletimDbId}
👨‍💼 Solicitado por: Coordenador
📅 Data: ${new Date().toLocaleString('pt-BR')}

📋 *Boletim Original:*
• Projeto: ${boletimPendente.extractedData.dados_boletim.projeto}
• Fazenda: ${boletimPendente.extractedData.dados_boletim.fazenda}
• Área Realizada: ${boletimPendente.extractedData.dados_boletim.area_realizada}

📝 *Observação:*
${observacao || 'Nenhuma observação específica'}

🔄 Por favor, corrija e reenvie o boletim.`;

        await sendWhatsAppMessage(boletimPendente.telefoneOriginal, mensagemCorrecao);
        
        // Confirmar para o coordenador
        await sendWhatsAppMessage(phone, `🔄 Solicitação de correção enviada! Funcionário foi notificado.\n\n🆔 *ID Boletim:* ${boletimPendente.id}\n🏛️ *ID Banco:* ${boletimPendente.boletimDbId}`);
        
        return res.status(200).json({ success: true });
        
    } catch (error) {
        console.error('Erro ao processar correção:', error);
        await sendWhatsAppMessage(phone, "❌ Erro ao processar correção. Tente novamente.");
        return res.status(500).json({ error: error.message });
    }
}

// Webhook para receber mensagens do Z-API
app.post('/webhook', async (req, res) => {
    try {
        console.log('Webhook recebido:', JSON.stringify(req.body, null, 2));
        
        // Extrair dados do formato Z-API
        const phone = req.body.phone;
        const messageText = req.body.text?.message || req.body.text?.url || req.body.message?.body;
        const fromMe = req.body.fromMe;
        
        // Ignorar mensagens enviadas por nós mesmos
        if (fromMe) {
            console.log('Mensagem enviada por nós - ignorando');
            return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
        }
        
        if (!messageText || !phone) {
            console.log('Mensagem ou telefone não fornecido');
            return res.status(400).json({ error: 'Mensagem ou telefone não fornecido' });
        }

        console.log('📱 Telefone:', phone);
        console.log('💬 Mensagem:', messageText);

        // Verificar se é resposta de aprovação/correção
        if (messageText.trim().startsWith('1') || messageText.toLowerCase().includes('aprovar')) {
            return await processarAprovacao(phone, messageText, res);
        }
        
        if (messageText.trim().startsWith('2') || messageText.toLowerCase().includes('corrigir')) {
            return await processarCorrecao(phone, messageText, res);
        }

        // Processar mensagem com OpenAI
        console.log('🤖 Processando mensagem com OpenAI...');
        const extractedData = await processMessageWithAI(messageText);
        
        // Inserir dados no banco
        console.log('💾 Inserindo dados no banco...');
        const result = await insertDataToDatabase(extractedData);
        
        // Buscar coordenador do projeto
        const coordenador = await getCoordenadorProjeto(extractedData.dados_boletim.projeto);
        
        if (coordenador) {
            // Gerar ID único para o boletim pendente
            const boletimId = Date.now().toString();
            
            // Normalizar telefone coordenador (usar apenas números)
            const telefoneCoordenador = coordenador.TELEFONE.replace(/[^\d]/g, '');
            
            console.log(`🧹 Limpando boletins pendentes anteriores...`);
            boletisPendentes.clear(); // Limpar todos os pendentes anteriores
            
            // Armazenar boletim para aprovação
            boletisPendentes.set(telefoneCoordenador, {
                id: boletimId,
                extractedData: extractedData,
                telefoneOriginal: phone,
                timestamp: new Date(),
                boletimDbId: result.boletimId // Guardar ID do banco para atualizar depois
            });
            
            console.log(`📞 Telefone do coordenador original: ${coordenador.TELEFONE}`);
            console.log(`📞 Telefone do coordenador normalizado: ${telefoneCoordenador}`);
            console.log(`🗂️ Boletins pendentes após inserção:`, Array.from(boletisPendentes.keys()));
            
            // Formatar e enviar mensagem para coordenador
            const mensagemAprovacao = formatarMensagemAprovacao(extractedData, phone, boletimId, result.boletimId);
            
            console.log(`📋 Enviando para aprovação - Coordenador: ${coordenador.USUARIO} (${telefoneCoordenador})`);
            await sendWhatsAppMessage(telefoneCoordenador, mensagemAprovacao);
            
            // Enviar confirmação para o funcionário
            const confirmMessage = `📋 *BOLETIM ENVIADO PARA APROVAÇÃO*

🆔 *ID Boletim:* ${boletimId}
🏛️ *ID Banco:* ${result.boletimId}
✅ Dados processados com sucesso!
👨‍💼 Enviado para: ${coordenador.USUARIO}
⏳ Aguardando aprovação...

📊 *Resumo:*
• Projeto: ${extractedData.dados_boletim.projeto}
• Fazenda: ${extractedData.dados_boletim.fazenda}
• Área Realizada: ${extractedData.dados_boletim.area_realizada}

🤖 Você será notificado do resultado!`;

            await sendWhatsAppMessage(phone, confirmMessage);
            
        } else {
            // Se não encontrar coordenador, processar como antes
            const confirmMessage = `✅ *BOLETIM PROCESSADO COM SUCESSO!*

📊 *Resumo:*
• Projeto: ${extractedData.dados_boletim.projeto}
• Fazenda: ${extractedData.dados_boletim.fazenda}
• Área Realizada: ${extractedData.dados_boletim.area_realizada}
• Colaboradores: ${extractedData.rateio_producao.colaboradores.length}

💾 Dados salvos no banco de dados!
🤖 Processado pelo Bot Z-API`;

            await sendWhatsAppMessage(phone, confirmMessage);
        }
        
        res.json({ 
            success: true, 
            message: 'Mensagem processada com sucesso',
            data: extractedData 
        });
        
    } catch (error) {
        console.error('Erro no webhook:', error.message);
        
        // Enviar mensagem de erro
        if (req.body.phone) {
            await sendWhatsAppMessage(req.body.phone, `❌ *ERRO AO PROCESSAR BOLETIM*

Erro: ${error.message}

Por favor, verifique o formato da mensagem e tente novamente.`);
        }
        
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Rota de teste
app.get('/', (req, res) => {
    res.json({ 
        message: 'Bot Z-API Florestal funcionando!',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Rota para testar banco de dados
app.get('/test-db', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request().query('SELECT TOP 1 * FROM BOLETIM_DIARIO_COPY');
        await pool.close();
        
        res.json({ 
            success: true, 
            message: 'Conexão com banco OK',
            sample: result.recordset[0] 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🤖 Bot Z-API Florestal rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: http://localhost:${PORT}/webhook`);
    console.log(`📊 Health Check: http://localhost:${PORT}/`);
});

module.exports = app;
