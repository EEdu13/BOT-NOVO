const sql = require('mssql');

// Configuração da conexão com Azure SQL Database
const config = {
    server: 'alrflorestal.database.windows.net',
    database: 'Tabela_teste',
    user: 'sqladmin',
    password: 'SenhaForte123!',
    options: {
        encrypt: true, // Azure requer SSL
        trustServerCertificate: false
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

async function checkTableColumns() {
    try {
        console.log('Conectando ao Azure SQL Database...');
        await sql.connect(config);
        
        // Query para obter colunas da tabela BOLETIM_DIARIO_COPY
        console.log('\n=== COLUNAS DA TABELA: BOLETIM_DIARIO_COPY ===');
        const resultBoletim = await sql.query(`
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'BOLETIM_DIARIO_COPY'
            ORDER BY ORDINAL_POSITION
        `);
        
        if (resultBoletim.recordset.length > 0) {
            resultBoletim.recordset.forEach((col, index) => {
                console.log(`${index + 1}. ${col.COLUMN_NAME} | Tipo: ${col.DATA_TYPE} | Nulo: ${col.IS_NULLABLE} | Tamanho: ${col.CHARACTER_MAXIMUM_LENGTH || 'N/A'}`);
            });
        } else {
            console.log('Tabela BOLETIM_DIARIO_COPY não encontrada ou não possui colunas.');
        }

        // Query para obter colunas da tabela PREMIO_COPY
        console.log('\n=== COLUNAS DA TABELA: PREMIO_COPY ===');
        const resultPremio = await sql.query(`
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'PREMIO_COPY'
            ORDER BY ORDINAL_POSITION
        `);
        
        if (resultPremio.recordset.length > 0) {
            resultPremio.recordset.forEach((col, index) => {
                console.log(`${index + 1}. ${col.COLUMN_NAME} | Tipo: ${col.DATA_TYPE} | Nulo: ${col.IS_NULLABLE} | Tamanho: ${col.CHARACTER_MAXIMUM_LENGTH || 'N/A'}`);
            });
        } else {
            console.log('Tabela PREMIO_COPY não encontrada ou não possui colunas.');
        }

        // Verificar se as tabelas existem
        console.log('\n=== VERIFICANDO EXISTÊNCIA DAS TABELAS ===');
        const tableCheck = await sql.query(`
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_NAME IN ('BOLETIM_DIARIO_COPY', 'PREMIO_COPY')
        `);
        
        console.log('Tabelas encontradas:');
        tableCheck.recordset.forEach(table => {
            console.log(`- ${table.TABLE_NAME}`);
        });

    } catch (error) {
        console.error('Erro ao conectar ou consultar o banco:', error.message);
    } finally {
        await sql.close();
        console.log('\nConexão fechada.');
    }
}

// Executar a função
checkTableColumns();
