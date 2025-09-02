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

// Função para enviar mensagem com botões via Z-API
async function sendWhatsAppMessageWithButtons(phone, messageData) {
    try {
        const url = `${zapiConfig.baseUrl}/${zapiConfig.instanceId}/token/${zapiConfig.token}/send-button-actions`;
        console.log(`🔗 URL Z-API: ${url}`);
        
        const payload = {
            phone: phone,
            message: messageData.message,
            title: "📋 BOLETIM PARA APROVAÇÃO",
            footer: "Bot Automático - ALR Florestal",
            buttonActions: [
                {
                    id: messageData.buttons[0].id,
                    type: "REPLY",
                    label: messageData.buttons[0].title
                },
                {
                    id: messageData.buttons[1].id,
                    type: "REPLY",
                    label: messageData.buttons[1].title
                }
            ]
        };
        
        console.log('📤 Payload com botões:', JSON.stringify(payload, null, 2));
        
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Client-Token': zapiConfig.clientToken
            },
            timeout: 10000
        });

        console.log('✅ Resposta Z-API (botões):', response.data);
        return response.data;
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem com botões:', error.message);
        // Fallback: enviar mensagem simples
        return await sendWhatsAppMessage(phone, messageData.message);
    }
}
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
async function processMessageWithAI(messageText) {
    try {
        const prompt = `
        Você é um ESPECIALISTA EM ANÁLISE DE BOLETINS FLORESTAIS com IA avançada para extrair dados de qualquer formato.

        REGRAS DE IDENTIFICAÇÃO SUPER INTELIGENTE:

        📅 DATA: Procure por "DATA:", "01/09/2025", "2025-09-01", "HOJE", ou datas em qualquer posição da mensagem
        🏗️ PROJETO: Números como "820", "830", "PROJETO: 820", "PROJ: 820"
        👤 SUPERVISOR: Nomes após "SUPERVISOR:", "SUPER:", "SUPERV:", ou primeiro nome em maiúsculas (ex: "OSCAR")
        👷 LÍDER: Após "LÍDER:", "LIDER:", "NOME_LIDER:", "LEAD:" ou nomes próprios
        🏢 EMPRESA: "LARSIL", "EMPRESA:", textos com "LTDA", "S.A.", "TERCEIRIZADA"
        🚜 SERVIÇO: "plantio", "capina", "aplicação", "SERVIÇO:", "ATIVIDADE:"
        🌱 FAZENDA: Após "FAZENDA:", nomes como "ype", "santa", "fazenda x"
        📍 TALHÃO: Números após "TALHÃO:", "TALHAO:", formato "008", "T008", "TALH:"
        📏 ÁREA REALIZADA: Números com vírgula após "REALIZADA:", "AREA REAL:", "executado:"
        📐 ÁREA TOTAL: Números após "AREA TOTAL:", "TOTAL:", "total da area:"
        📊 ÁREA RESTANTE: Números após "RESTANTE:", "resta:", "falta:"
        🟢 STATUS: "ABERTO", "FECHADO", "EM ANDAMENTO", após "STATUS:"
        🔢 LAUDO: Números grandes como "11.348" (pontos = milhares) → vai para campo TIPO
        🧬 CLONE: Códigos como "Suza 0217", "AEC 0144", "clone:", "material:"
        🌱 PLANTADAS: Números grandes após "PLANTADAS:", "mudas:", "plantas:"
        🗑️ DESCARTE: Números após "DESCARTE:", "perdas:", "refugo:"
        💊 INSUMOS: "MAP", "prez", "tuit", "adubo" com quantidades
        👥 COLABORADORES: Listas de números separados por vírgula ou traço
        🤝 APOIO: Registros com "premio", "operador", "motorista"
        📋 FORMATO EQUIPE APOIO: "Tp235-54-premio-operador"
          - PREFIXO: "Tp235" (antes do primeiro hífen)
          - REGISTRO: "54" (número após primeiro hífen)
          - PRÊMIO: "SIM" se contém "premio", "NAO" se não contém
          - CLASSE: "OPERADOR", "MOTORISTA", etc. (última parte em maiúsculas)
          - VALOR: 30.00 se prêmio = "SIM", 0 se "NAO"

        REGRAS DE FORMATAÇÃO BRASILEIRA:
        - VÍRGULA = decimal (40,42 mantém vírgula no resultado: "40,42")
        - PONTO em números grandes = milhares (11.348 → vai para TIPO como laudo: "11348")
        - Nomes: apenas primeira letra maiúscula se for nome completo
        - "HOJE" = data atual (2025-09-02)
        - Datas brasileiras: DD/MM/YYYY → YYYY-MM-DD

        IGNORE COMPLETAMENTE:
        ❌ Linhas só com traços/underscores: "------------", "-------------"
        ❌ Títulos de seções: "EQUIPE APOIO ENVOLVIDA", "OBS:", "DIVISÃO DO PREMIO IGUAL:"
        ❌ Separadores visuais
        ❌ Textos explicativos

        EXEMPLOS DE IDENTIFICAÇÃO FLEXÍVEL:
        "DATA: 01/09/2025 PROJETO: 820 SUPERVISOR: OSCAR" → data="2025-09-01", projeto="820", supervisor="OSCAR"
        "820 - OSCAR - plantio - ype - T008 - 5,42ha - HOJE" → projeto="820", supervisor="OSCAR", area_realizada="40,42"
        "Projeto 820 Oscar plantio fazenda ype talhão 008 área 40,42" → mesmo resultado
        
        EXEMPLO EQUIPE APOIO:
        "Tp235-54-premio-operador" → {"prefixo": "Tp235", "registro": "54", "premio": "SIM", "classe": "OPERADOR", "valor": 30.00}
        "TP001-528-motorista" → {"prefixo": "TP001", "registro": "528", "premio": "NAO", "classe": "MOTORISTA", "valor": 0}

        ATENÇÃO MÁXIMA AOS ERROS ANTERIORES:
        ❌ SUPERVISOR ≠ lista de colaboradores (OSCAR ≠ "118,15,413")
        ❌ EMPRESA ≠ nome de líder (LARSIL ≠ "Elton Costa") 
        ❌ COD deve ficar VAZIO (campo reservado)
        ❌ LAUDO (números grandes) vai para campo TIPO: "11348"
        ✅ Mantenha VÍRGULAS nos decimais: "40,42" (não converta para 40.42)

        JSON DE SAÍDA OBRIGATÓRIO:
        {
            "tipo": "boletim_diario",
            "dados_boletim": {
                "data": "YYYY-MM-DD",
                "projeto": "string",
                "equipe": "",
                "supervisor": "string (apenas nomes, nunca números)",
                "lider": "string (apenas nomes, nunca empresa)", 
                "cod": "",
                "empresa": "string (apenas empresas)",
                "servico": "string",
                "fazenda": "string",
                "talhao": "string",
                "area_realizada": "string com vírgula: ex: 40,42",
                "area_total": "string com vírgula: ex: 59,99",
                "area_restante": "string com vírgula: ex: 3,81", 
                "status_talhao": "string",
                "lote_nf": "",
                "tipo": "string (LAUDO números grandes aqui: ex: 11348)",
                "clone": "string",
                "plantadas": "number",
                "descarte": "number",
                "insumos": [{"lote": "", "insumo": "string", "quantidade": "string com vírgula"}],
                "observacao": "string"
            },
            "rateio_producao": {
                "colaboradores": ["array de números como strings"],
                "valores": "array mesmo tamanho",
                "divisao_igual": "SIM ou NAO"
            },
            "equipe_apoio": [
                {"prefixo": "Tp235", "registro": "54", "premio": "SIM", "classe": "OPERADOR", "valor": 30.00},
                {"prefixo": "TP001", "registro": "528", "premio": "NAO", "classe": "MOTORISTA", "valor": 0}
            ],
            "estrutura_apoio": [
                {"prefixo": "TP001", "registro": "528", "premio": "SIM", "classe": "MOTORISTA", "valor": 30.00}
            ]
        }

        SEJA FLEXÍVEL MAS PRECISO! A mensagem pode ter campos em qualquer ordem.

        Mensagem para analisar:
        ${messageText}

        Responda APENAS com o JSON válido, sem explicações.
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
            let num = parseFloat(String(value).replace(',', '.'));
            if (isNaN(num)) num = 0;
            
            // Arredondar para 2 casas decimais para evitar problemas de precisão
            const result = Math.round(num * 100) / 100;
            
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
        boletimRequest.input('projeto', sql.VarChar, String(dados.projeto || '').toUpperCase());
        boletimRequest.input('equipe', sql.VarChar, String(dados.equipe || '').toUpperCase());
        boletimRequest.input('supervisor', sql.VarChar, String(dados.supervisor || '').toUpperCase());
        boletimRequest.input('lider', sql.VarChar, String(dados.lider || '').toUpperCase());
        boletimRequest.input('cod', sql.VarChar, String(dados.cod || '').toUpperCase());
        boletimRequest.input('empresa', sql.VarChar, String(dados.empresa || '').toUpperCase());
        boletimRequest.input('servico', sql.VarChar, String(dados.servico || '').toUpperCase());
        boletimRequest.input('fazenda', sql.VarChar, String(dados.fazenda || '').toUpperCase());
        boletimRequest.input('talhao', sql.VarChar, String(dados.talhao || '').toUpperCase());
        boletimRequest.input('area_realizada', sql.Decimal(10,6), toDecimalSafe(dados.area_realizada));
        boletimRequest.input('status', sql.VarChar, String(dados.status_talhao || '').toUpperCase());
        boletimRequest.input('tipo', sql.VarChar, String(dados.tipo || '').toUpperCase());
        boletimRequest.input('clone', sql.VarChar, String(dados.clone || '').toUpperCase());
        boletimRequest.input('plantadas', sql.Decimal(10,0), toDecimalSafe(dados.plantadas));
        boletimRequest.input('descarte', sql.Decimal(10,0), toDecimalSafe(dados.descarte));
        
        // Insumos
        const insumos = dados.insumos || [];
        boletimRequest.input('lote1', sql.VarChar, String(insumos[0]?.lote || '').toUpperCase());
        boletimRequest.input('insumo1', sql.VarChar, String(insumos[0]?.insumo || '').toUpperCase());
        boletimRequest.input('quantidade1', sql.Decimal(10,6), toDecimalSafe(insumos[0]?.quantidade));
        boletimRequest.input('lote2', sql.VarChar, String(insumos[1]?.lote || '').toUpperCase());
        boletimRequest.input('insumo2', sql.VarChar, String(insumos[1]?.insumo || '').toUpperCase());
        boletimRequest.input('quantidade2', sql.Decimal(10,6), toDecimalSafe(insumos[1]?.quantidade));
        boletimRequest.input('lote3', sql.VarChar, String(insumos[2]?.lote || '').toUpperCase());
        boletimRequest.input('insumo3', sql.VarChar, String(insumos[2]?.insumo || '').toUpperCase());
        boletimRequest.input('quantidade3', sql.Decimal(10,6), toDecimalSafe(insumos[2]?.quantidade));
        boletimRequest.input('observacao', sql.VarChar, String(dados.observacao || '').toUpperCase());

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
            console.error('❌ ERRO SQL DETALHADO:');
            console.error('🔍 Mensagem:', queryError.message);
            console.error('🔍 Código:', queryError.code);
            console.error('🔍 Número:', queryError.number);
            console.error('❌ Estado:', queryError.state);
            console.error('🔍 Linha:', queryError.lineNumber);
            console.error('🔍 Procedimento:', queryError.procName);
            
            console.error('📊 DADOS ORIGINAIS QUE CAUSARAM ERRO:');
            console.error('📅 Data original:', dados.data, '| Tipo:', typeof dados.data);
            console.error('🏗️ Projeto original:', dados.projeto, '| Tipo:', typeof dados.projeto);
            console.error('📏 Área original:', dados.area_realizada, '| Tipo:', typeof dados.area_realizada);
            console.error('🌱 Plantadas original:', dados.plantadas, '| Tipo:', typeof dados.plantadas);
            console.error('🗑️ Descarte original:', dados.descarte, '| Tipo:', typeof dados.descarte);
            console.error('👤 Supervisor original:', dados.supervisor, '| Tipo:', typeof dados.supervisor);
            console.error('🏭 Fazenda original:', dados.fazenda, '| Tipo:', typeof dados.fazenda);
            console.error('📝 Observação original:', dados.observacao, '| Tipo:', typeof dados.observacao);
            
            console.error('🔄 VALORES CONVERTIDOS:');
            console.error('📅 Data convertida:', toDateSafe(dados.data));
            console.error('📏 Área convertida:', toDecimalSafe(dados.area_realizada));
            console.error('🌱 Plantadas convertida:', toDecimalSafe(dados.plantadas));
            console.error('🗑️ Descarte convertido:', toDecimalSafe(dados.descarte));
            
            // Tentar identificar qual campo está causando problema
            const problematicFields = [];
            
            if (!toDateSafe(dados.data)) problematicFields.push('data');
            if (String(dados.projeto || '').length > 50) problematicFields.push('projeto (muito longo)');
            if (!Number.isFinite(toDecimalSafe(dados.area_realizada))) problematicFields.push('area_realizada');
            if (!Number.isFinite(toDecimalSafe(dados.plantadas))) problematicFields.push('plantadas');
            if (!Number.isFinite(toDecimalSafe(dados.descarte))) problematicFields.push('descarte');
            
            console.error('🚨 CAMPOS POTENCIALMENTE PROBLEMÁTICOS:', problematicFields);
            
            throw new Error(`Erro SQL detalhado: ${queryError.message} | Campos suspeitos: ${problematicFields.join(', ')}`);
        }
        
        // Pegar o ID do boletim inserido para usar como RAW nos prêmios
        const boletimIdResult = await pool.request().query('SELECT TOP 1 ID FROM BOLETIM_DIARIO_COPY ORDER BY ID DESC');
        const boletimId = boletimIdResult.recordset[0]?.ID;
        console.log('🆔 ID do boletim inserido:', boletimId);
        
        // Validar se o boletimId foi obtido corretamente
        if (!boletimId || isNaN(boletimId)) {
            throw new Error(`ID do boletim inválido: ${boletimId}`);
        }

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
                    
                    // Validar todos os valores antes de inserir
                    const rawValue = parseInt(boletimId);
                    const dataValue = toDateSafe(dados.data);
                    const projetoValue = String(dados.projeto || '');
                    const supervisorValue = String(dados.supervisor || '');
                    const registroValue = String(rateio.colaboradores[i] || '');
                    const atividadeValue = String(dados.servico || '');
                    const producaoValue = toDecimalSafe(valorPorColaborador);
                    
                    console.log(`🔍 Validando colaborador ${i + 1}:`, {
                        RAW: rawValue, tipo: typeof rawValue,
                        data: dataValue, tipo_data: typeof dataValue,
                        projeto: projetoValue, tipo_projeto: typeof projetoValue,
                        supervisor: supervisorValue, tipo_supervisor: typeof supervisorValue,
                        registro: registroValue, tipo_registro: typeof registroValue,
                        atividade: atividadeValue, tipo_atividade: typeof atividadeValue,
                        producao: producaoValue, tipo_producao: typeof producaoValue
                    });
                    
                    // Verificar se algum valor é inválido
                    if (isNaN(rawValue)) throw new Error(`RAW inválido: ${rawValue}`);
                    if (!dataValue) throw new Error(`Data inválida: ${dataValue}`);
                    if (isNaN(producaoValue)) throw new Error(`Produção inválida: ${producaoValue}`);
                    
                    request.input('RAW', sql.BigInt, rawValue);
                    request.input('data', sql.DateTime, dataValue);
                    request.input('projeto', sql.VarChar, projetoValue.toUpperCase());
                    request.input('supervisor', sql.VarChar, supervisorValue.toUpperCase());
                    request.input('registro', sql.VarChar, registroValue.toUpperCase());
                    request.input('colaborador', sql.VarChar, ''); // Auto-preenchido
                    request.input('atividade', sql.VarChar, atividadeValue.toUpperCase());
                    request.input('producao', sql.Decimal(10,6), producaoValue);
                    request.input('classe', sql.VarChar, '');
                    request.input('valor', sql.Decimal(10,2), 0);
                    request.input('prefixo', sql.VarChar, '');
                    
                    await request.query(premioQuery);
                    console.log(`✅ Colaborador ${i + 1} inserido com sucesso`);
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
        console.log('👥 Inserindo equipe de apoio...', extractedData.equipe_apoio.length, 'registros');
        for (let j = 0; j < extractedData.equipe_apoio.length; j++) {
            const apoio = extractedData.equipe_apoio[j];
            if (apoio.registro) {
                try {
                    console.log(`👤 Processando apoio ${j + 1}: ${apoio.registro} - ${apoio.classe} - R$ ${apoio.valor}`);
                    
                    const request = pool.request();
                    
                    // Validar todos os valores
                    const rawValue = parseInt(boletimId);
                    const dataValue = toDateSafe(dados.data);
                    const projetoValue = String(dados.projeto || '');
                    const supervisorValue = String(dados.supervisor || '');
                    const registroValue = String(apoio.registro || '');
                    const atividadeValue = String(dados.servico || '');
                    const classeValue = String(apoio.classe || '');
                    const valorValue = toDecimalSafe(apoio.valor);
                    
                    console.log(`🔍 Validando apoio ${j + 1}:`, {
                        RAW: rawValue, tipo: typeof rawValue,
                        registro: registroValue, tipo_registro: typeof registroValue,
                        classe: classeValue, tipo_classe: typeof classeValue,
                        valor: valorValue, tipo_valor: typeof valorValue
                    });
                    
                    // Verificações
                    if (isNaN(rawValue)) throw new Error(`RAW inválido: ${rawValue}`);
                    if (!dataValue) throw new Error(`Data inválida: ${dataValue}`);
                    if (isNaN(valorValue)) throw new Error(`Valor inválido: ${valorValue}`);
                    
                    request.input('RAW', sql.BigInt, rawValue);
                    request.input('data', sql.DateTime, dataValue);
                    request.input('projeto', sql.VarChar, projetoValue.toUpperCase());
                    request.input('supervisor', sql.VarChar, supervisorValue.toUpperCase());
                    request.input('registro', sql.VarChar, registroValue.toUpperCase());
                    request.input('colaborador', sql.VarChar, '');
                    request.input('atividade', sql.VarChar, atividadeValue.toUpperCase());
                    request.input('producao', sql.Decimal(10,2), 0);
                    request.input('classe', sql.VarChar, classeValue.toUpperCase());
                    request.input('valor', sql.Decimal(10,2), valorValue);
                    request.input('prefixo', sql.VarChar, '');
                    
                    await request.query(premioQuery);
                    console.log(`✅ Apoio ${j + 1} inserido com sucesso`);
                } catch (apoioError) {
                    console.error(`❌ Erro ao inserir apoio ${j + 1}:`, apoioError.message);
                    console.error(`📊 Dados do apoio:`, apoio);
                    throw new Error(`Erro na equipe de apoio ${j + 1}: ${apoioError.message}`);
                }
            }
        }

        // Inserir estrutura de apoio
        console.log('🏗️ Inserindo estrutura de apoio...', extractedData.estrutura_apoio.length, 'registros');
        for (let k = 0; k < extractedData.estrutura_apoio.length; k++) {
            const estrutura = extractedData.estrutura_apoio[k];
            if (estrutura.registro) {
                try {
                    console.log(`🚛 Processando estrutura ${k + 1}: ${estrutura.prefixo} - ${estrutura.registro} - ${estrutura.classe} - R$ ${estrutura.valor}`);
                    
                    const request = pool.request();
                    
                    // Validar todos os valores
                    const rawValue = parseInt(boletimId);
                    const dataValue = toDateSafe(dados.data);
                    const projetoValue = String(dados.projeto || '');
                    const supervisorValue = String(dados.supervisor || '');
                    const registroValue = String(estrutura.registro || '');
                    const atividadeValue = String(dados.servico || '');
                    const classeValue = String(estrutura.classe || '');
                    const valorValue = toDecimalSafe(estrutura.valor);
                    const prefixoValue = String(estrutura.prefixo || '');
                    
                    console.log(`🔍 Validando estrutura ${k + 1}:`, {
                        RAW: rawValue, tipo: typeof rawValue,
                        prefixo: prefixoValue, tipo_prefixo: typeof prefixoValue,
                        registro: registroValue, tipo_registro: typeof registroValue,
                        classe: classeValue, tipo_classe: typeof classeValue,
                        valor: valorValue, tipo_valor: typeof valorValue
                    });
                    
                    // Verificações
                    if (isNaN(rawValue)) throw new Error(`RAW inválido: ${rawValue}`);
                    if (!dataValue) throw new Error(`Data inválida: ${dataValue}`);
                    if (isNaN(valorValue)) throw new Error(`Valor inválido: ${valorValue}`);
                    
                    request.input('RAW', sql.BigInt, rawValue);
                    request.input('data', sql.DateTime, dataValue);
                    request.input('projeto', sql.VarChar, projetoValue.toUpperCase());
                    request.input('supervisor', sql.VarChar, supervisorValue.toUpperCase());
                    request.input('registro', sql.VarChar, registroValue.toUpperCase());
                    request.input('colaborador', sql.VarChar, '');
                    request.input('atividade', sql.VarChar, atividadeValue.toUpperCase());
                    request.input('producao', sql.Decimal(10,2), 0);
                    request.input('classe', sql.VarChar, classeValue.toUpperCase());
                    request.input('valor', sql.Decimal(10,2), valorValue);
                    request.input('prefixo', sql.VarChar, prefixoValue.toUpperCase());
                    
                    await request.query(premioQuery);
                    console.log(`✅ Estrutura ${k + 1} inserida com sucesso`);
                } catch (estruturaError) {
                    console.error(`❌ Erro ao inserir estrutura ${k + 1}:`, estruturaError.message);
                    console.error(`📊 Dados da estrutura:`, estrutura);
                    throw new Error(`Erro na estrutura de apoio ${k + 1}: ${estruturaError.message}`);
                }
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

// Funções de busca inteligente removidas - não funcionavam conforme esperado

// Função para completar nomes automaticamente usando organograma
async function completarNomesAutomaticamente(dados) {
    try {
        console.log('🔍 Iniciando busca inteligente no organograma...');
        
        const projeto = dados.dados_boletim.projeto;
        
        // Busca inteligente removida - não estava funcionando conforme esperado
        
        return dados;
        
    } catch (error) {
        console.error('Erro ao completar nomes automaticamente:', error.message);
        return dados;
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
async function formatarMensagemAprovacao(extractedData, telefoneOriginal, boletimId, boletimDbId) {
    // Buscar dados atualizados do banco
    const dadosDoBanco = await buscarDadosBoletimPorId(boletimDbId);
    
    let mensagem; // Declarar mensagem fora dos blocos
    
    if (dadosDoBanco) {
        // Usar dados do banco (formatação padrão)
        const dataFormatada = dadosDoBanco.DATA_BOLETIM ? 
            new Date(dadosDoBanco.DATA_BOLETIM).toLocaleDateString('pt-BR') : 
            new Date().toLocaleDateString('pt-BR');
        
        const areaFormatada = dadosDoBanco.AREA_REALIZADA ? 
            String(dadosDoBanco.AREA_REALIZADA).replace('.', ',') : 'N/A';
        
        mensagem = `🔍 *APROVAÇÃO DE BOLETIM*\n\n`;
        mensagem += `🆔 *ID Boletim:* ${boletimId}\n`;
        mensagem += `🏛️ *ID Banco:* ${boletimDbId}\n`;
        mensagem += `📱 *Enviado por:* ${telefoneOriginal}\n`;
        mensagem += `📅 *Data:* ${dataFormatada}\n`;
        mensagem += `🏗️ *Projeto:* ${dadosDoBanco.PROJETO || 'N/A'}\n`;
        mensagem += `👨‍💼 *Supervisor:* ${dadosDoBanco.SUPERVISOR || 'N/A'}\n`;
        mensagem += `👨‍🔧 *Líder:* ${dadosDoBanco.LIDER || 'N/A'}\n`;
        mensagem += `🚜 *Serviço:* ${dadosDoBanco.SERVICO || 'PLANTIO'}\n`;
        mensagem += `🌱 *Fazenda:* ${dadosDoBanco.FAZENDA || 'N/A'}\n`;
        mensagem += `📏 *Área Realizada:* ${areaFormatada}\n\n`;
        
        // Adicionar colaboradores da extração original
        const rateio = extractedData.rateio_producao;
        if (rateio && rateio.colaboradores.length > 0) {
            mensagem += `👥 *Colaboradores (${rateio.colaboradores.length}):*\n`;
            rateio.colaboradores.forEach((collab, i) => {
                mensagem += `• ${collab.colaborador}\n`;
            });
            mensagem += '\n';
        }
        
        // Adicionar equipe apoio da extração original
        const equipeApoio = extractedData.equipe_apoio;
        if (equipeApoio && equipeApoio.length > 0) {
            mensagem += `🤝 *Equipe Apoio:*\n`;
            equipeApoio.forEach(apoio => {
                mensagem += `• ${apoio.registro} - ${apoio.classe}\n`;
            });
        }
        
    } else {
        // Fallback para dados da extração original se não encontrar no banco
        const dados = extractedData.dados_boletim;
        const rateio = extractedData.rateio_producao;
        
        // Função para formatar data no padrão brasileiro DD/MM/AA
        const formatarDataBrasileira = (data) => {
        if (!data) return '';
        
        // Se já está no formato DD/MM/YYYY, converter para DD/MM/AA
        if (data.includes('/')) {
            const partes = data.split('/');
            if (partes.length === 3) {
                const dia = partes[0].padStart(2, '0');
                const mes = partes[1].padStart(2, '0');
                const ano = partes[2].length === 4 ? partes[2].slice(-2) : partes[2];
                return `${dia}/${mes}/${ano}`;
            }
        }
        
        // Se está no formato YYYY-MM-DD, converter
        if (data.includes('-')) {
            const partes = data.split('-');
            if (partes.length === 3) {
                const ano = partes[0].slice(-2);
                const mes = partes[1].padStart(2, '0');
                const dia = partes[2].padStart(2, '0');
                return `${dia}/${mes}/${ano}`;
            }
        }
        
        return data; // Retorna como está se não conseguir converter
    };
    
    mensagem = `🔍 *APROVAÇÃO DE BOLETIM*\n\n`;
    mensagem += `🆔 *ID Boletim:* ${boletimId}\n`;
    mensagem += `🏛️ *ID Banco:* ${boletimDbId}\n`;
    mensagem += `📱 *Enviado por:* ${telefoneOriginal}\n`;
    mensagem += `📅 *Data:* ${formatarDataBrasileira(dados.data)}\n`;
    mensagem += `🏗️ *Projeto:* ${dados.projeto}\n`;
    mensagem += `👨‍💼 *Supervisor:* ${dados.supervisor}\n`;
    mensagem += `👨‍🔧 *Líder:* ${dados.lider}\n`;
    mensagem += `🚜 *Serviço:* ${dados.servico}\n`;
    mensagem += `🌱 *Fazenda:* ${dados.fazenda}\n`;
    mensagem += `📏 *Área Realizada:* ${String(dados.area_realizada).replace('.', ',')}\n\n`;
    
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
    }
    
    // Adicionar instruções de aprovação/correção
    mensagem += `\n`;
    mensagem += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    mensagem += `🔄 *AÇÕES DISPONÍVEIS:*\n\n`;
    mensagem += `✅ Para aprovar digite: *APROVAR ${boletimDbId}*\n`;
    mensagem += `❌ Para corrigir digite: *CORRIGIR ${boletimDbId}*\n`;
    mensagem += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Retornar apenas a mensagem (sem botões)
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
    
    let mensagem = `📋 *APONTAMENTO RESUMIDO DO DIA*\n\n`;
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
        console.log(`🔍 PROCESSANDO APROVAÇÃO:`);
        console.log(`📞 Telefone: ${phone}`);
        console.log(`📝 Mensagem: ${messageText}`);
        console.log(`🆔 Boletim ID: ${boletimId}`);
        
        // Normalizar telefone (usar apenas números)
        const telefoneNormalizado = phone.replace(/[^\d]/g, '');
        console.log(`📞 Telefone normalizado: ${telefoneNormalizado}`);
        
        const boletinsArray = boletisPendentes.get(telefoneNormalizado);
        console.log(`📋 Boletins pendentes encontrados:`, boletinsArray ? boletinsArray.length : 0);
        
        if (!boletinsArray || boletinsArray.length === 0) {
            console.log(`❌ Nenhum boletim pendente para ${telefoneNormalizado}`);
            await sendWhatsAppMessage(phone, "❌ Nenhum boletim pendente encontrado para aprovação.");
            return res.status(200).json({ success: true });
        }
        
        // Verificar se é aprovação específica por ID do banco (formato: "APROVAR 123" ou "APROVAR_123")
        const match = messageText.match(/APROVAR[\s_]+(\d+)/i);
        let boletimParaAprovar = null;
        let indiceBoletim = -1;
        
        if (match) {
            // Aprovação específica por ID do banco
            const idBanco = match[1];
            
            indiceBoletim = boletinsArray.findIndex(b => b.boletimDbId == idBanco);
            if (indiceBoletim !== -1) {
                boletimParaAprovar = boletinsArray[indiceBoletim];
            } else {
                await sendWhatsAppMessage(phone, `❌ Boletim ID ${idBanco} não encontrado.`);
                return res.status(200).json({ success: true });
            }
        } else {
            // Aprovação simples - se só tem um boletim, aprova; se tem vários, mostra lista
            if (boletinsArray.length === 1) {
                boletimParaAprovar = boletinsArray[0];
                indiceBoletim = 0;
            } else {
                // Múltiplos boletins - mostrar lista para escolha
                let mensagemEscolha = `📋 *BOLETINS PENDENTES*\n\n`;
                
                boletinsArray.forEach((boletim, index) => {
                    const dados = boletim.extractedData.dados_boletim;
                    mensagemEscolha += `📄 *ID: ${boletim.boletimDbId}*\n`;
                    mensagemEscolha += `📅 ${dados.data} | 🏗️ ${dados.projeto}\n`;
                    mensagemEscolha += `🌱 ${dados.fazenda} | 📏 ${dados.area_realizada}\n\n`;
                });
                
                mensagemEscolha += `*Para aprovar:*\n`;
                mensagemEscolha += `Digite: *APROVAR ID* (ex: APROVAR ${boletinsArray[0].boletimDbId})`;
                
                await sendWhatsAppMessage(phone, mensagemEscolha);
                return res.status(200).json({ success: true });
            }
        }
        
        // Atualizar banco de dados - marcar como aprovado
        await atualizarStatusBoletim(boletimParaAprovar.boletimDbId, 'APROVADO', phone);
        
        // Buscar dados atualizados do banco para mensagem de aprovação
        const dadosDoBanco = await buscarDadosBoletimPorId(boletimParaAprovar.boletimDbId);
        
        // Remover o boletim específico da lista
        boletinsArray.splice(indiceBoletim, 1);
        
        // Se não há mais boletins para este coordenador, remover a entrada
        if (boletinsArray.length === 0) {
            boletisPendentes.delete(telefoneNormalizado);
        }
        
        console.log(`✅ Boletim ${boletimParaAprovar.id} aprovado e removido da lista`);
        console.log(`📊 Boletins restantes para ${telefoneNormalizado}: ${boletinsArray.length}`);
        
        // Enviar aprovação para o funcionário usando dados do banco
        const mensagemAprovacao = dadosDoBanco ? 
            formatarMensagemAprovacaoDoBanco(dadosDoBanco, boletimParaAprovar.boletimDbId) :
            `✅ *BOLETIM APROVADO!*

🆔 *ID Boletim:* ${boletimParaAprovar.id}
🏛️ *ID Banco:* ${boletimParaAprovar.boletimDbId}
👨‍💼 Aprovado por: Coordenador
📅 Data: ${new Date().toLocaleString('pt-BR')}

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

// Função para buscar dados do boletim por ID no banco
async function buscarDadosBoletimPorId(boletimId) {
    try {
        const pool = sql.pool || await sql.connect(dbConfig);
        const result = await pool.request()
            .input('id', sql.BigInt, boletimId)
            .query(`
                SELECT 
                    ID,
                    DATA_BOLETIM,
                    PROJETO,
                    FAZENDA,
                    RESPONSAVEL,
                    AREA_REALIZADA,
                    TURNO,
                    FUNCIONARIO,
                    LIDER,
                    SUPERVISOR,
                    APROVADO_POR
                FROM BOLETIM_DIARIO_COPY 
                WHERE ID = @id
            `);
        
        if (result.recordset.length > 0) {
            console.log(`✅ Dados do boletim ${boletimId} encontrados no banco`);
            return result.recordset[0];
        } else {
            console.log(`❌ Boletim ${boletimId} não encontrado no banco`);
            return null;
        }
    } catch (error) {
        console.error('❌ Erro ao buscar dados do boletim:', error.message);
        return null;
    }
}

// Função para formatar mensagem de aprovação usando dados do banco
function formatarMensagemAprovacaoDoBanco(dadosBanco, boletimId) {
    const dataFormatada = dadosBanco.DATA_BOLETIM ? 
        new Date(dadosBanco.DATA_BOLETIM).toLocaleDateString('pt-BR') : 
        new Date().toLocaleDateString('pt-BR');
    
    const areaFormatada = dadosBanco.AREA_REALIZADA ? 
        String(dadosBanco.AREA_REALIZADA).replace('.', ',') : 'N/A';
    
    return `✅ *BOLETIM APROVADO!*

🆔 *ID Banco:* ${boletimId}
👨‍💼 *Aprovado por:* ${dadosBanco.APROVADO_POR || 'Coordenador'}
📅 *Data Aprovação:* ${new Date().toLocaleString('pt-BR')}

📊 *DADOS CONFIRMADOS NO SISTEMA:*
• *Projeto:* ${dadosBanco.PROJETO || 'N/A'}
• *Fazenda:* ${dadosBanco.FAZENDA || 'N/A'}
• *Responsável:* ${dadosBanco.RESPONSAVEL || 'N/A'}
• *Funcionário:* ${dadosBanco.FUNCIONARIO || 'N/A'}
• *Líder:* ${dadosBanco.LIDER || 'N/A'}
• *Supervisor:* ${dadosBanco.SUPERVISOR || 'N/A'}
• *Turno:* ${dadosBanco.TURNO || 'N/A'}
• *Data Boletim:* ${dataFormatada}
• *Área Realizada:* ${areaFormatada} ha

💾 *Status:* APROVADO E CONFIRMADO NO BANCO DE DADOS!`;
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

        // Extrair ID do banco se especificado na mensagem (formato: CORRIGIR 123 ou CORRIGIR_123)
        const idBancoMatch = messageText.match(/CORRIGIR[\s_]+(\d+)/i);
        let boletimParaCorrigir;
        let indiceParaRemover;

        if (idBancoMatch) {
            const idBanco = idBancoMatch[1];
            
            indiceParaRemover = boletinsArray.findIndex(b => b.boletimDbId == idBanco);
            if (indiceParaRemover !== -1) {
                boletimParaCorrigir = boletinsArray[indiceParaRemover];
            } else {
                await sendWhatsAppMessage(phone, `❌ Boletim ID ${idBanco} não encontrado!`);
                return res.status(200).json({ success: true });
            }
        } else {
            // Usar o boletim mais recente (último do array)
            indiceParaRemover = boletinsArray.length - 1;
            boletimParaCorrigir = boletinsArray[indiceParaRemover];
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
        } else {
            boletisPendentes.set(telefoneNormalizado, boletinsArray);
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
• Área Realizada: ${String(boletimParaCorrigir.extractedData.dados_boletim.area_realizada).replace('.', ',')}

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
        
        console.log(`🔍 DEBUG WEBHOOK COMPLETO:`, JSON.stringify(req.body, null, 2));
        console.log(`📝 Texto da mensagem: "${messageText}"`);
        
        // Verificar se é uma resposta/reply (mensagem citada)
        const isReply = req.body.quotedMsg || req.body.quoted || req.body.contextInfo || req.body.message?.extendedTextMessage?.contextInfo;
        const quotedMessage = req.body.quotedMsg?.body || req.body.quoted?.body || req.body.contextInfo?.quotedMessage?.body || req.body.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
        
        // Ignorar mensagens enviadas por nós mesmos
        if (fromMe) {
            return res.status(200).json({ success: true, message: 'Mensagem própria ignorada' });
        }
        
        if (!messageText || !phone) {
            return res.status(400).json({ error: 'Mensagem ou telefone não fornecido' });
        }

        // Detectar aprovação com múltiplas variações (incluindo erros de digitação)
        const textoLimpo = messageText.trim().toLowerCase();
        
        // Palavras específicas que indicam aprovação
        const palavrasAprovacao = [
            'aprovar', 'aprova', 'aprovo', 'aprov', 'aprovar ', 'aprova ', 
            'approve', 'aprove', 'aprovr', 'apruvar',
            'ok', 'sim', 'certo', 'correto'
        ];
        
        // Palavras específicas que indicam correção
        const palavrasCorrecao = [
            'corrigir', 'corrigi', 'corrigir ', 'corrigi ', 'corrige', 
            'corige', 'coregir', 'coregi', 'correção', 'correcao',
            'errado', 'incorreto', 'não', 'nao'
        ];
        
        // Função para extrair ID do texto (APROVAR 147 ou CORRIGIR 147)
        const extrairId = (texto) => {
            const matches = texto.match(/\d+/);
            return matches ? matches[0] : null;
        };
        
        // Detecção mais específica - verificar se começa com a palavra
        const isAprovacao = (textoLimpo.startsWith('1') || 
                           palavrasAprovacao.some(palavra => textoLimpo.startsWith(palavra)) ||
                           (isReply && palavrasAprovacao.some(palavra => textoLimpo.includes(palavra)))) &&
                           !palavrasCorrecao.some(palavra => textoLimpo.startsWith(palavra));
                           
        const isCorrecao = (textoLimpo.startsWith('2') || 
                          palavrasCorrecao.some(palavra => textoLimpo.startsWith(palavra)) ||
                          (isReply && palavrasCorrecao.some(palavra => textoLimpo.includes(palavra)))) &&
                          !palavrasAprovacao.some(palavra => textoLimpo.startsWith(palavra));
        
        console.log(`✅ É aprovação? ${isAprovacao}`);
        console.log(`❌ É correção? ${isCorrecao}`);
        
        if (isAprovacao) {
            console.log(`✅ PROCESSANDO COMO APROVAÇÃO`);
            const boletimId = extrairId(messageText);
            const comandoCompleto = boletimId ? `APROVAR ${boletimId}` : messageText;
            return await processarAprovacao(phone, comandoCompleto, res);
        }
        
        if (isCorrecao) {
            console.log(`❌ PROCESSANDO COMO CORREÇÃO`);
            const boletimId = extrairId(messageText);
            const comandoCompleto = boletimId ? `CORRIGIR ${boletimId}` : messageText;
            return await processarCorrecao(phone, comandoCompleto, res);
        }

        // Processar mensagem com OpenAI
        let extractedData = await processMessageWithAI(messageText);
        
        // Completar nomes automaticamente usando organograma (OSCAR → OSCAR ANTONIO TEIXEIRA PRATES)
        extractedData = await completarNomesAutomaticamente(extractedData);
        
        // Inserir dados no banco
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
            const mensagemAprovacao = await formatarMensagemAprovacao(extractedData, phone, boletimId, result.boletimId);
            
            await sendWhatsAppMessage(telefoneCoordenador, mensagemAprovacao);
            
            // Enviar para usuários de QUALIDADE (somente visualização)
            if (usuariosQualidade.length > 0) {
                const mensagemQualidade = formatarMensagemQualidade(extractedData, phone, boletimId, result.boletimId);
                
                for (const usuario of usuariosQualidade) {
                    const telefoneQualidade = usuario.TELEFONE.replace(/[^\d]/g, '');
                    await sendWhatsAppMessage(telefoneQualidade, mensagemQualidade);
                }
            }
            
            // Buscar dados do banco para confirmação
            const dadosDoBanco = await buscarDadosBoletimPorId(result.boletimId);
            
            // Enviar confirmação para o funcionário
            const confirmMessage = dadosDoBanco ? 
                `📋 *BOLETIM ENVIADO PARA APROVAÇÃO*

🆔 *ID Boletim:* ${boletimId}
🏛️ *ID Banco:* ${result.boletimId}
✅ Dados processados com sucesso!
👨‍💼 Enviado para: ${coordenador.USUARIO}
⏳ Aguardando aprovação...

📊 *DADOS CONFIRMADOS NO BANCO:*
• *Projeto:* ${dadosDoBanco.PROJETO || 'N/A'}
• *Fazenda:* ${dadosDoBanco.FAZENDA || 'N/A'}
• *Responsável:* ${dadosDoBanco.RESPONSAVEL || 'N/A'}
• *Supervisor:* ${dadosDoBanco.SUPERVISOR || 'N/A'}
• *Área Realizada:* ${dadosDoBanco.AREA_REALIZADA ? String(dadosDoBanco.AREA_REALIZADA).replace('.', ',') : 'N/A'} ha

🤖 Você será notificado do resultado!` : 
                `📋 *BOLETIM ENVIADO PARA APROVAÇÃO*

🆔 *ID Boletim:* ${boletimId}
🏛️ *ID Banco:* ${result.boletimId}
✅ Dados processados com sucesso!
👨‍💼 Enviado para: ${coordenador.USUARIO}
⏳ Aguardando aprovação...

📊 *Resumo:*
• Projeto: ${extractedData.dados_boletim.projeto}
• Fazenda: ${extractedData.dados_boletim.fazenda}
• Área Realizada: ${String(extractedData.dados_boletim.area_realizada).replace('.', ',')}

🤖 Você será notificado do resultado!`;

            await sendWhatsAppMessage(phone, confirmMessage);
            
        } else {
            // Buscar dados do banco para confirmação
            const dadosDoBanco = await buscarDadosBoletimPorId(result.boletimId);
            
            // Se não encontrar coordenador, processar como antes
            const confirmMessage = dadosDoBanco ?
                `✅ *BOLETIM PROCESSADO COM SUCESSO!*

📊 *DADOS CONFIRMADOS NO BANCO:*
• *Projeto:* ${dadosDoBanco.PROJETO || 'N/A'}
• *Fazenda:* ${dadosDoBanco.FAZENDA || 'N/A'}
• *Responsável:* ${dadosDoBanco.RESPONSAVEL || 'N/A'}
• *Supervisor:* ${dadosDoBanco.SUPERVISOR || 'N/A'}
• *Área Realizada:* ${dadosDoBanco.AREA_REALIZADA ? String(dadosDoBanco.AREA_REALIZADA).replace('.', ',') : 'N/A'} ha
• *Colaboradores:* ${extractedData.rateio_producao.colaboradores.length}

💾 Dados salvos no banco de dados!
🤖 Processado pelo Bot Z-API` :
                `✅ *BOLETIM PROCESSADO COM SUCESSO!*

📊 *Resumo:*
• Projeto: ${extractedData.dados_boletim.projeto}
• Fazenda: ${extractedData.dados_boletim.fazenda}
• Área Realizada: ${String(extractedData.dados_boletim.area_realizada).replace('.', ',')}
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
