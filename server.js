const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');
const sql = require('mssql');
require('dotenv').config();

// Suprimir avisos de deprecação do punycode
process.noDeprecation = true;

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
// Estrutura para armazenar boletins pendentes por coordenador
const boletisPendentes = new Map(); // telefone -> array de boletins

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
                [DATA_EXECUÇÃO], [PROJETO], [LÍDER], [SUPERVISOR], [NOME_DO_LIDER], 
                [COD], [EMPRESA], [SERVIÇO], [FAZENDA], [TALHAO], [PRODUÇÃO], [STATUS],
                [TIPO], [CLONE], [PLANTADAS], [DESCARTE], [LOTE1], [INSUMO1], [QUANTIDADE1],
                [LOTE2], [INSUMO2], [QUANTIDADE2], [LOTE3], [INSUMO3], [QUANTIDADE3],
                [OBSERVAÇÃO], [CRIADO], [CRIADO_POR], [MODIFICADO], [MODIFICADO_POR]
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
        
        // Funções auxiliares para conversões seguras
        const toDecimalSafe = (value) => {
            if (value === null || value === undefined || value === '') return 0;
            const num = parseFloat(String(value).replace(',', '.'));
            const result = isNaN(num) ? 0 : num;
            console.log(`🔢 Conversão decimal: "${value}" → ${result}`);
            return result;
        };
        
        const toDateSafe = (value) => {
            if (!value) return new Date();
            
            // Se já é uma data válida
            if (value instanceof Date) return value;
            
            // Tentar converter string para data
            let dateStr = String(value);
            console.log(`📅 Conversão data: "${value}" → processando...`);
            
            // Diferentes formatos possíveis
            if (dateStr.includes('/')) {
                // Formato DD/MM/YYYY ou MM/DD/YYYY
                const parts = dateStr.split('/');
                if (parts.length === 3) {
                    // Assumir DD/MM/YYYY
                    const day = parseInt(parts[0]);
                    const month = parseInt(parts[1]) - 1; // Mês começa em 0
                    const year = parseInt(parts[2]);
                    const result = new Date(year, month, day);
                    console.log(`📅 Data convertida: ${result}`);
                    return result;
                }
            } else if (dateStr.includes('-')) {
                // Formato YYYY-MM-DD
                const result = new Date(dateStr);
                console.log(`📅 Data convertida: ${result}`);
                return result;
            }
            
            // Fallback para data atual se não conseguir converter
            const fallback = new Date();
            console.log(`📅 Data fallback: ${fallback}`);
            return fallback;
        };
        
        boletimRequest.input('data', sql.DateTime, toDateSafe(dados.data));
        boletimRequest.input('projeto', sql.VarChar, String(dados.projeto || ''));
        boletimRequest.input('equipe', sql.VarChar, String(dados.equipe || ''));
        boletimRequest.input('supervisor', sql.VarChar, String(dados.supervisor || ''));
        boletimRequest.input('lider', sql.VarChar, String(dados.lider || ''));
        boletimRequest.input('cod', sql.VarChar, String(dados.cod || ''));
        boletimRequest.input('empresa', sql.VarChar, String(dados.empresa || ''));
        boletimRequest.input('servico', sql.VarChar, String(dados.servico || ''));
        boletimRequest.input('fazenda', sql.VarChar, String(dados.fazenda || ''));
        boletimRequest.input('talhao', sql.VarChar, String(dados.talhao || ''));
        boletimRequest.input('area_realizada', sql.Decimal, toDecimalSafe(dados.area_realizada));
        boletimRequest.input('status', sql.VarChar, String(dados.status_talhao || ''));
        boletimRequest.input('tipo', sql.VarChar, String(dados.tipo || ''));
        boletimRequest.input('clone', sql.VarChar, String(dados.clone || ''));
        boletimRequest.input('plantadas', sql.Decimal, toDecimalSafe(dados.plantadas));
        boletimRequest.input('descarte', sql.Decimal, toDecimalSafe(dados.descarte));
        
        // Insumos
        const insumos = dados.insumos || [];
        boletimRequest.input('lote1', sql.VarChar, String(insumos[0]?.lote || ''));
        boletimRequest.input('insumo1', sql.VarChar, String(insumos[0]?.insumo || ''));
        boletimRequest.input('quantidade1', sql.Decimal, toDecimalSafe(insumos[0]?.quantidade));
        boletimRequest.input('lote2', sql.VarChar, String(insumos[1]?.lote || ''));
        boletimRequest.input('insumo2', sql.VarChar, String(insumos[1]?.insumo || ''));
        boletimRequest.input('quantidade2', sql.Decimal, toDecimalSafe(insumos[1]?.quantidade));
        boletimRequest.input('lote3', sql.VarChar, String(insumos[2]?.lote || ''));
        boletimRequest.input('insumo3', sql.VarChar, String(insumos[2]?.insumo || ''));
        boletimRequest.input('quantidade3', sql.Decimal, toDecimalSafe(insumos[2]?.quantidade));
        boletimRequest.input('observacao', sql.VarChar, String(dados.observacao || ''));

        console.log('📊 Dados sendo inseridos:', {
            data: toDateSafe(dados.data),
            projeto: String(dados.projeto || ''),
            area_realizada: toDecimalSafe(dados.area_realizada),
            plantadas: toDecimalSafe(dados.plantadas),
            descarte: toDecimalSafe(dados.descarte)
        });

        try {
            // Validação individual dos campos críticos antes da inserção
            console.log('🔍 Validando campos críticos...');
            
            const dataValidada = toDateSafe(dados.data);
            console.log(`📅 Data validada: ${dataValidada}`);
            
            const areaValidada = toDecimalSafe(dados.area_realizada);
            console.log(`📏 Área validada: ${areaValidada}`);
            
            const plantadasValidada = toDecimalSafe(dados.plantadas);
            console.log(`🌱 Plantadas validada: ${plantadasValidada}`);
            
            const descarteValidado = toDecimalSafe(dados.descarte);
            console.log(`🗑️ Descarte validado: ${descarteValidado}`);
            
            console.log('✅ Todos os campos validados, executando query...');
            
            await boletimRequest.query(boletimQuery);
            console.log('✅ Boletim inserido com sucesso!');
        } catch (queryError) {
            console.error('❌ Erro detalhado na query do boletim:', queryError.message);
            console.error('📊 Dados originais que causaram erro:', JSON.stringify({
                data_original: dados.data,
                projeto_original: dados.projeto,
                area_realizada_original: dados.area_realizada,
                plantadas_original: dados.plantadas,
                descarte_original: dados.descarte,
                supervisor_original: dados.supervisor,
                fazenda_original: dados.fazenda,
                tipo_data: typeof dados.data,
                tipo_area: typeof dados.area_realizada,
                tipo_plantadas: typeof dados.plantadas,
                tipo_descarte: typeof dados.descarte
            }, null, 2));
            throw new Error(`Erro no INSERT do boletim: ${queryError.message}`);
        }
        
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
        const areaRealizada = toDecimalSafe(dados.area_realizada);
        const valorPorColaborador = rateio.colaboradores.length > 0 ? 
            areaRealizada / rateio.colaboradores.length : 0;
        
        console.log(`📊 Área realizada: ${areaRealizada}, Colaboradores: ${rateio.colaboradores.length}, Valor por colaborador: ${valorPorColaborador}`);
        
        // Verificar se o valor por colaborador é válido
        if (isNaN(valorPorColaborador) || !isFinite(valorPorColaborador)) {
            console.error('❌ Valor por colaborador inválido:', valorPorColaborador);
            throw new Error(`Valor por colaborador inválido: ${valorPorColaborador}`);
        }
        
        for (let i = 0; i < rateio.colaboradores.length; i++) {
            if (rateio.colaboradores[i] && rateio.colaboradores[i].trim() !== '') {
                try {
                    console.log(`   - Colaborador ${i + 1}: ${rateio.colaboradores[i]} = ${valorPorColaborador}`);
                    const request = pool.request();
                    request.input('RAW', sql.BigInt, boletimId); // Conectar com o boletim
                    request.input('data', sql.DateTime, toDateSafe(dados.data));
                    request.input('projeto', sql.VarChar, String(dados.projeto || ''));
                    request.input('supervisor', sql.VarChar, String(dados.supervisor || ''));
                    request.input('registro', sql.VarChar, String(rateio.colaboradores[i] || ''));
                    request.input('colaborador', sql.VarChar, ''); // Auto-preenchido
                    request.input('atividade', sql.VarChar, String(dados.servico || ''));
                    request.input('producao', sql.Decimal, toDecimalSafe(valorPorColaborador));
                    request.input('classe', sql.VarChar, '');
                    request.input('valor', sql.Decimal, 0);
                    request.input('prefixo', sql.VarChar, '');
                    
                    await request.query(premioQuery);
                } catch (premioError) {
                    console.error(`❌ Erro ao inserir colaborador ${i + 1} (${rateio.colaboradores[i]}):`, premioError.message);
                    console.error(`📊 Dados do colaborador:`, {
                        boletimId,
                        colaborador: rateio.colaboradores[i],
                        valorPorColaborador,
                        tipo_valor: typeof valorPorColaborador
                    });
                    throw new Error(`Erro no rateio colaborador ${i + 1}: ${premioError.message}`);
                }
            }
        }

        // Inserir equipe de apoio
        for (const apoio of extractedData.equipe_apoio) {
            if (apoio.registro) {
                const request = pool.request();
                request.input('RAW', sql.BigInt, boletimId); // Conectar com o boletim
                request.input('data', sql.DateTime, toDateSafe(dados.data));
                request.input('projeto', sql.VarChar, String(dados.projeto || ''));
                request.input('supervisor', sql.VarChar, String(dados.supervisor || ''));
                request.input('registro', sql.VarChar, String(apoio.registro || ''));
                request.input('colaborador', sql.VarChar, '');
                request.input('atividade', sql.VarChar, String(dados.servico || ''));
                request.input('producao', sql.Decimal, 0);
                request.input('classe', sql.VarChar, String(apoio.classe || ''));
                request.input('valor', sql.Decimal, toDecimalSafe(apoio.valor));
                request.input('prefixo', sql.VarChar, '');
                
                await request.query(premioQuery);
            }
        }

        // Inserir estrutura de apoio
        for (const estrutura of extractedData.estrutura_apoio) {
            if (estrutura.registro) {
                const request = pool.request();
                request.input('RAW', sql.BigInt, boletimId); // Conectar com o boletim
                request.input('data', sql.DateTime, toDateSafe(dados.data));
                request.input('projeto', sql.VarChar, String(dados.projeto || ''));
                request.input('supervisor', sql.VarChar, String(dados.supervisor || ''));
                request.input('registro', sql.VarChar, String(estrutura.registro || ''));
                request.input('colaborador', sql.VarChar, '');
                request.input('atividade', sql.VarChar, String(dados.servico || ''));
                request.input('producao', sql.Decimal, 0);
                request.input('classe', sql.VarChar, String(estrutura.classe || ''));
                request.input('valor', sql.Decimal, toDecimalSafe(estrutura.valor));
                request.input('prefixo', sql.VarChar, String(estrutura.prefixo || ''));
                
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

// Função para buscar usuários de QUALIDADE por projeto
async function getUsuariosQualidadePorProjeto(projeto) {
    try {
        const pool = sql.pool || await sql.connect(dbConfig);
        const result = await pool.request()
            .input('projeto', sql.VarChar, projeto)
            .query(`
                SELECT USUARIO, TELEFONE, PERFIL, PROJETO 
                FROM USUARIOS 
                WHERE PERFIL = 'QUALIDADE' AND PROJETO = @projeto
            `);
        
        return result.recordset;
    } catch (error) {
        console.error('❌ Erro ao buscar usuários de qualidade por projeto:', error.message);
        return [];
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

// Função para formatar mensagem para usuários de QUALIDADE (somente visualização)
function formatarMensagemQualidade(extractedData, telefoneOriginal, boletimId, boletimDbId) {
    const dados = extractedData.dados_boletim;
    const rateio = extractedData.rateio_producao;
    
    // Função auxiliar para converter para maiúsculas de forma segura
    const toUpperSafe = (value) => {
        if (value === null || value === undefined) return '';
        return String(value).toUpperCase();
    };
    
    let mensagem = `� *APONTAMENTO RESUMIDO DO DIA*\n\n`;
    mensagem += `🆔 *ID BOLETIM:* ${boletimId}\n`;
    mensagem += `🏛️ *ID BANCO:* ${boletimDbId}\n`;
    mensagem += `📱 *ENVIADO POR:* ${telefoneOriginal}\n`;
    mensagem += `📅 *DATA:* ${toUpperSafe(dados.data)}\n`;
    mensagem += `🏗️ *PROJETO:* ${toUpperSafe(dados.projeto)}\n`;
    mensagem += `👨‍💼 *SUPERVISOR:* ${toUpperSafe(dados.supervisor)}\n`;
    mensagem += `🚜 *SERVIÇO:* ${toUpperSafe(dados.servico)}\n`;
    mensagem += `🌱 *FAZENDA:* ${toUpperSafe(dados.fazenda)}\n`;
    mensagem += `📏 *ÁREA REALIZADA:* ${toUpperSafe(dados.area_realizada)}\n\n`;
    
    mensagem += `👥 *COLABORADORES (${rateio.colaboradores.length}):*\n`;
    rateio.colaboradores.forEach((collab, i) => {
        mensagem += `• ${toUpperSafe(collab)}\n`;
    });
    
    if (extractedData.equipe_apoio.length > 0) {
        mensagem += `\n🤝 *EQUIPE APOIO:*\n`;
        extractedData.equipe_apoio.forEach(apoio => {
            mensagem += `• ${toUpperSafe(apoio.registro)} - ${toUpperSafe(apoio.classe)}\n`;
        });
    }
    
    if (dados.observacoes) {
        mensagem += `\n📝 *OBSERVAÇÕES:* ${toUpperSafe(dados.observacoes)}\n`;
    }
    
    mensagem += `\n⚠️ *MENSAGEM SOMENTE PARA VISUALIZAÇÃO*\n`;
    mensagem += `✅ *AGUARDANDO APROVAÇÃO DO SUPERVISOR*`;
    
    return mensagem;
}

// Função para processar aprovação
async function processarAprovacao(phone, messageText, res, boletimId = null) {
    try {
        console.log('🔍 Processando aprovação...');
        console.log('📱 Telefone original:', phone);
        
        // Normalizar telefone (usar apenas números)
        const telefoneNormalizado = phone.replace(/[^\d]/g, '');
        console.log('📱 Telefone normalizado:', telefoneNormalizado);
        
        const boletinsArray = boletisPendentes.get(telefoneNormalizado);
        console.log(`🗂️ Boletins pendentes para ${telefoneNormalizado}:`, boletinsArray?.length || 0);
        
        if (!boletinsArray || boletinsArray.length === 0) {
            console.log('❌ Nenhum boletim encontrado para telefone:', telefoneNormalizado);
            await sendWhatsAppMessage(phone, "❌ Nenhum boletim pendente encontrado para aprovação.");
            return res.status(200).json({ success: true });
        }
        
        // Verificar se é aprovação específica por ID (formato: "1 ID" ou "aprovar ID")
        const match = messageText.match(/(?:1|aprovar)\s+(\d+)/i);
        let boletimParaAprovar = null;
        let indiceBoletim = -1;
        
        if (match) {
            // Aprovação específica por ID
            const idEspecifico = match[1];
            console.log(`🎯 Procurando boletim específico ID: ${idEspecifico}`);
            
            indiceBoletim = boletinsArray.findIndex(b => b.id === idEspecifico);
            if (indiceBoletim !== -1) {
                boletimParaAprovar = boletinsArray[indiceBoletim];
                console.log(`✅ Encontrou boletim específico ID: ${idEspecifico}`);
            } else {
                await sendWhatsAppMessage(phone, `❌ Boletim ID ${idEspecifico} não encontrado.`);
                return res.status(200).json({ success: true });
            }
        } else {
            // Aprovação simples - pegar o mais recente
            if (boletinsArray.length === 1) {
                boletimParaAprovar = boletinsArray[0];
                indiceBoletim = 0;
                console.log(`✅ Único boletim encontrado ID: ${boletimParaAprovar.id}`);
            } else {
                // Múltiplos boletins - mostrar lista para escolha
                let mensagemEscolha = `📋 *MÚLTIPLOS BOLETINS PENDENTES*\n\n`;
                mensagemEscolha += `Você tem ${boletinsArray.length} boletins aguardando aprovação:\n\n`;
                
                boletinsArray.forEach((boletim, index) => {
                    const dados = boletim.extractedData.dados_boletim;
                    mensagemEscolha += `🆔 *${boletim.id}*\n`;
                    mensagemEscolha += `📅 ${dados.data} | 🏗️ ${dados.projeto}\n`;
                    mensagemEscolha += `🌱 ${dados.fazenda} | 📏 ${dados.area_realizada}\n\n`;
                });
                
                mensagemEscolha += `*Para aprovar específico:*\n`;
                mensagemEscolha += `Digite: *1 ID* (ex: 1 ${boletinsArray[0].id})\n\n`;
                mensagemEscolha += `*Para aprovar o mais recente:*\n`;
                mensagemEscolha += `Digite apenas: *1*`;
                
                await sendWhatsAppMessage(phone, mensagemEscolha);
                
                // Aprovar o mais recente automaticamente se não especificou ID
                boletimParaAprovar = boletinsArray[boletinsArray.length - 1];
                indiceBoletim = boletinsArray.length - 1;
                console.log(`✅ Aprovando mais recente ID: ${boletimParaAprovar.id}`);
            }
        }
        
        // Atualizar banco de dados - marcar como aprovado
        await atualizarStatusBoletim(boletimParaAprovar.boletimDbId, 'APROVADO', phone);
        
        // Remover o boletim específico da lista
        boletinsArray.splice(indiceBoletim, 1);
        
        // Se não há mais boletins para este coordenador, remover a entrada
        if (boletinsArray.length === 0) {
            boletisPendentes.delete(telefoneNormalizado);
        }
        
        console.log(`✅ Boletim ${boletimParaAprovar.id} aprovado e removido da lista`);
        console.log(`📊 Boletins restantes para ${telefoneNormalizado}: ${boletinsArray.length}`);
        
        // Enviar aprovação para o funcionário
        const mensagemAprovacao = `✅ *BOLETIM APROVADO!*

🆔 *ID Boletim:* ${boletimParaAprovar.id}
🏛️ *ID Banco:* ${boletimParaAprovar.boletimDbId}
👨‍💼 Aprovado por: Coordenador
📅 Data: ${new Date().toLocaleString('pt-BR')}

📊 *Resumo do Boletim:*
• Projeto: ${boletimParaAprovar.extractedData.dados_boletim.projeto}
• Fazenda: ${boletimParaAprovar.extractedData.dados_boletim.fazenda}
• Área Realizada: ${boletimParaAprovar.extractedData.dados_boletim.area_realizada}

💾 Dados confirmados no sistema!`;

        await sendWhatsAppMessage(boletimParaAprovar.telefoneOriginal, mensagemAprovacao);
        
        // Confirmar para o coordenador
        await sendWhatsAppMessage(phone, `✅ Boletim aprovado com sucesso! Funcionário foi notificado.\n\n🆔 *ID Boletim:* ${boletimParaAprovar.id}\n🏛️ *ID Banco:* ${boletimParaAprovar.boletimDbId}\n📊 *Restantes:* ${boletinsArray.length}`);
        
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
async function processarCorrecao(phone, messageText, res, boletimId = null) {
    try {
        // Normalizar telefone (usar apenas números)
        const telefoneNormalizado = phone.replace(/[^\d]/g, '');
        
        if (!boletisPendentes.has(telefoneNormalizado)) {
            await sendWhatsAppMessage(phone, "❌ Nenhum boletim pendente encontrado para correção.");
            return res.status(200).json({ success: true });
        }

        const boletinsArray = boletisPendentes.get(telefoneNormalizado);
        
        if (boletinsArray.length === 0) {
            await sendWhatsAppMessage(phone, "❌ Nenhum boletim pendente encontrado para correção.");
            boletisPendentes.delete(telefoneNormalizado);
            return res.status(200).json({ success: true });
        }

        console.log(`📋 CORREÇÃO - Coordenador: ${telefoneNormalizado}, Boletins disponíveis: ${boletinsArray.length}`);

        // Extrair ID se especificado na mensagem
        const idMatch = messageText.match(/ID\s*:?\s*(\w+)/i);
        let boletimParaCorrigir;
        let indiceParaRemover;

        if (idMatch) {
            const idEspecificado = idMatch[1].trim();
            console.log(`🎯 ID especificado para correção: ${idEspecificado}`);
            
            indiceParaRemover = boletinsArray.findIndex(b => b.id === idEspecificado);
            if (indiceParaRemover !== -1) {
                boletimParaCorrigir = boletinsArray[indiceParaRemover];
                console.log(`✅ Boletim encontrado para correção: ${boletimParaCorrigir.id}`);
            } else {
                await sendWhatsAppMessage(phone, `❌ Boletim com ID ${idEspecificado} não encontrado!`);
                return res.status(200).json({ success: true });
            }
        } else {
            // Usar o boletim mais recente (último do array)
            indiceParaRemover = boletinsArray.length - 1;
            boletimParaCorrigir = boletinsArray[indiceParaRemover];
            console.log(`🔄 Nenhum ID especificado, usando boletim mais recente: ${boletimParaCorrigir.id}`);
        }
        
        // Extrair observação (tudo após "2 - CORRIGIR")
        const observacao = messageText.replace(/^2\s*-?\s*CORRIGIR\s*/i, '').trim();
        
        // Atualizar banco de dados - marcar como rejeitado
        await atualizarStatusBoletim(boletimParaCorrigir.boletimDbId, 'REJEITADO', phone);
        
        // Remover o boletim específico do array
        boletinsArray.splice(indiceParaRemover, 1);
        
        // Se não há mais boletins, remover o telefone do Map
        if (boletinsArray.length === 0) {
            boletisPendentes.delete(telefoneNormalizado);
            console.log(`📱 Removido telefone ${telefoneNormalizado} do Map (sem boletins restantes)`);
        } else {
            boletisPendentes.set(telefoneNormalizado, boletinsArray);
            console.log(`📱 Telefone ${telefoneNormalizado} mantido no Map com ${boletinsArray.length} boletins restantes`);
        }
        
        // Enviar solicitação de correção para o funcionário
        const mensagemCorrecao = `🔄 *CORREÇÃO SOLICITADA*

🆔 *ID Boletim:* ${boletimParaCorrigir.id}
🏛️ *ID Banco:* ${boletimParaCorrigir.boletimDbId}
👨‍💼 Solicitado por: Coordenador
📅 Data: ${new Date().toLocaleString('pt-BR')}

📋 *Boletim Original:*
• Projeto: ${boletimParaCorrigir.extractedData.dados_boletim.projeto}
• Fazenda: ${boletimParaCorrigir.extractedData.dados_boletim.fazenda}
• Área Realizada: ${boletimParaCorrigir.extractedData.dados_boletim.area_realizada}

📝 *Observação:*
${observacao || 'Nenhuma observação específica'}

🔄 Por favor, corrija e reenvie o boletim.`;

        await sendWhatsAppMessage(boletimParaCorrigir.telefoneOriginal, mensagemCorrecao);
        
        // Confirmar para o coordenador
        await sendWhatsAppMessage(phone, `🔄 Solicitação de correção enviada! Funcionário foi notificado.\n\n🆔 *ID Boletim:* ${boletimParaCorrigir.id}\n🏛️ *ID Banco:* ${boletimParaCorrigir.boletimDbId}\n📊 *Restantes:* ${boletinsArray.length}`);
        
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
        console.log('🔔 ===== WEBHOOK RECEBIDO =====');
        console.log('📋 Dados completos:', JSON.stringify(req.body, null, 2));
        console.log('🔍 Headers:', JSON.stringify(req.headers, null, 2));
        console.log('================================');
        
        // Extrair dados do formato Z-API (múltiplas possibilidades)
        const phone = req.body.phone;
        const messageText = req.body.text?.message || 
                          req.body.text?.url || 
                          req.body.message?.body || 
                          req.body.message?.conversation || 
                          req.body.message?.extendedTextMessage?.text ||
                          req.body.body ||
                          req.body.content;
        const fromMe = req.body.fromMe;
        
        // Verificar se é uma resposta/reply (mensagem citada)
        const isReply = req.body.quotedMsg || req.body.quoted || req.body.contextInfo || req.body.message?.extendedTextMessage?.contextInfo;
        const quotedMessage = req.body.quotedMsg?.body || req.body.quoted?.body || req.body.contextInfo?.quotedMessage?.body || req.body.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
        
        console.log('📱 Telefone:', phone);
        console.log('💬 Mensagem:', messageText);
        console.log('🔄 É Reply?:', !!isReply);
        console.log('📄 Mensagem Citada:', quotedMessage);
        
        // Ignorar mensagens enviadas por nós mesmos
        if (fromMe) {
            console.log('Mensagem enviada por nós - ignorando');
            return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
        }
        
        if (!messageText || !phone) {
            console.log('Mensagem ou telefone não fornecido');
            return res.status(400).json({ error: 'Mensagem ou telefone não fornecido' });
        }

        // Verificar se é resposta de aprovação/correção (normal ou reply)
        const isAprovacao = messageText.trim().startsWith('1') || 
                           messageText.toLowerCase().includes('aprovar') ||
                           (isReply && (messageText.toLowerCase().includes('aprovar') || messageText.trim() === '1'));
                           
        const isCorrecao = messageText.trim().startsWith('2') || 
                          messageText.toLowerCase().includes('corrigir') ||
                          (isReply && (messageText.toLowerCase().includes('corrigir') || messageText.trim() === '2'));
        
        if (isAprovacao) {
            console.log('✅ Detectada aprovação (reply ou mensagem normal)');
            return await processarAprovacao(phone, messageText, res);
        }
        
        if (isCorrecao) {
            console.log('🔄 Detectada correção (reply ou mensagem normal)');
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
        
        // Buscar usuários de QUALIDADE do mesmo projeto
        const usuariosQualidade = await getUsuariosQualidadePorProjeto(extractedData.dados_boletim.projeto);
        
        if (coordenador) {
            // Gerar ID único para o boletim pendente
            const boletimId = Date.now().toString();
            
            // Normalizar telefone coordenador (usar apenas números)
            const telefoneCoordenador = coordenador.TELEFONE.replace(/[^\d]/g, '');
            
            // Armazenar boletim para aprovação (permitir múltiplos por coordenador)
            if (!boletisPendentes.has(telefoneCoordenador)) {
                boletisPendentes.set(telefoneCoordenador, []);
            }
            
            const novoBoletim = {
                id: boletimId,
                extractedData: extractedData,
                telefoneOriginal: phone,
                timestamp: new Date(),
                boletimDbId: result.boletimId
            };
            
            boletisPendentes.get(telefoneCoordenador).push(novoBoletim);
            
            console.log(`📞 Telefone do coordenador original: ${coordenador.TELEFONE}`);
            console.log(`📞 Telefone do coordenador normalizado: ${telefoneCoordenador}`);
            console.log(`🗂️ Boletins pendentes para ${telefoneCoordenador}:`, boletisPendentes.get(telefoneCoordenador).length);
            console.log(`🗂️ Total coordenadores com boletins:`, boletisPendentes.size);
            
            // Formatar e enviar mensagem para coordenador
            const mensagemAprovacao = formatarMensagemAprovacao(extractedData, phone, boletimId, result.boletimId);
            
            console.log(`📋 Enviando para aprovação - Coordenador: ${coordenador.USUARIO} (${telefoneCoordenador})`);
            await sendWhatsAppMessage(telefoneCoordenador, mensagemAprovacao);
            
            // Enviar para usuários de QUALIDADE (somente visualização)
            if (usuariosQualidade.length > 0) {
                const mensagemQualidade = formatarMensagemQualidade(extractedData, phone, boletimId, result.boletimId);
                
                for (const usuario of usuariosQualidade) {
                    const telefoneQualidade = usuario.TELEFONE.replace(/[^\d]/g, '');
                    console.log(`👀 Enviando para visualização - Qualidade: ${usuario.USUARIO} (${telefoneQualidade})`);
                    await sendWhatsAppMessage(telefoneQualidade, mensagemQualidade);
                }
            }
            
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
