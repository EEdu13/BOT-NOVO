# Bot Z-API Florestal 🌲🤖

# Bot WhatsApp Z-API Florestal 🌲🤖

Sistema automatizado para processar boletins diários florestais via WhatsApp com aprovação por coordenadores.

## 🚀 Deploy Railway

Este bot está configurado para deploy automático no Railway.

### 📋 Passo a Passo para Deploy:

1. **Fork/Clone este repositório**
2. **Conecte ao Railway:**
   - Acesse [railway.app](https://railway.app)
   - Conecte sua conta GitHub
   - Selecione "Deploy from GitHub repo"
   - Escolha este repositório

3. **Configure as Variáveis de Ambiente no Railway:**

### 🔧 Variáveis de Ambiente Necessárias:

Configure essas variáveis no painel do Railway:

```bash
# BANCO DE DADOS
DB_SERVER=seu_servidor.database.windows.net
DB_DATABASE=nome_do_banco
DB_USER=usuario_banco
DB_PASSWORD=senha_banco

# OPENAI
OPENAI_API_KEY=configure_sua_chave_aqui

# Z-API  
ZAPI_INSTANCE_ID=sua_instance_id
ZAPI_TOKEN=seu_token
ZAPI_CLIENT_TOKEN=seu_client_token
ZAPI_BASE_URL=https://api.z-api.io/instances

# SERVIDOR
PORT=3000
NODE_ENV=production
```

4. **Configure o Webhook na Z-API:**
   - URL: `https://[seu-projeto].up.railway.app/webhook`

## 📋 Funcionalidades

- ✅ Processamento de boletins via WhatsApp
- ✅ Integração com OpenAI para extração de dados
- ✅ Sistema de aprovação por coordenadores 
- ✅ Salvamento automático no Azure SQL Database
- ✅ Cálculo automático de rateio
- ✅ Notificações com IDs de rastreamento

## 🔧 Como usar

1. Envie um boletim formatado via WhatsApp
2. O bot processa e envia para aprovação do coordenador
3. Coordenador responde "1" para aprovar ou "2" para corrigir
4. Sistema atualiza banco de dados e notifica funcionário

## 🌐 Webhook

Após o deploy, configure o webhook na Z-API:
```
https://[seu-dominio-railway].up.railway.app/webhook
```

## 📊 Monitoramento

- Health Check: `https://[seu-dominio]/`
- Logs disponíveis no painel do Railway

## 🚀 Funcionalidades

- ✅ Recebe mensagens via WhatsApp (Z-API)
- 🤖 Processa texto com OpenAI GPT-4
- 📊 Extrai dados do boletim diário automaticamente
- 💾 Salva dados no Azure SQL Database
- 📱 Envia confirmação via WhatsApp
- 🔄 Calcula rateio de produção automático
- 🏆 Gerencia prêmios da equipe

## 📋 Formato da Mensagem

```
DATA: HOJE OU 26/08
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
OBS: Dia chuvoso, terreno molhado
```

## ⚙️ Configuração

### 1. Variáveis de Ambiente (.env)

```env
# Banco de Dados Azure SQL
DB_SERVER=seu_servidor.database.windows.net
DB_DATABASE=nome_do_banco
DB_USER=usuario_banco
DB_PASSWORD=senha_banco

# OpenAI
OPENAI_API_KEY=sua_chave_openai_aqui

# Z-API (Configure no seu painel Z-API)
ZAPI_INSTANCE_ID=sua_instance_id
ZAPI_TOKEN=seu_token
ZAPI_BASE_URL=https://api.z-api.io/instances

# Servidor
PORT=3000
NODE_ENV=production
```

### 2. Instalação

```bash
npm install
```

### 3. Executar Localmente

```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

## 🗄️ Estrutura do Banco de Dados

### Tabela: BOLETIM_DIARIO_COPY
- Armazena dados principais do boletim
- 101 colunas incluindo projeto, fazenda, produção, insumos, etc.

### Tabela: PREMIO_COPY  
- Armazena dados de colaboradores e prêmios
- 40 colunas incluindo registro, colaborador, classe, valores, etc.

## 🌐 Deploy no Railway

### 1. Conectar GitHub ao Railway
```bash
# Inicializar git
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <seu-repositorio>
git push -u origin main
```

### 2. Deploy no Railway
1. Acesse [railway.app](https://railway.app)
2. Conecte seu repositório GitHub
3. Configure as variáveis de ambiente
4. Deploy automático!

### 3. Configurar Webhook Z-API
- URL do Webhook: `https://seu-app.railway.app/webhook`
- Método: POST

## 📱 Como Usar

1. **Configure Z-API**: Adicione o webhook do Railway
2. **Envie Mensagem**: Mande o boletim via WhatsApp
3. **Processamento**: Bot analisa com OpenAI
4. **Banco de Dados**: Dados são salvos automaticamente
5. **Confirmação**: Recebe confirmação no WhatsApp

## 🧪 Testes

```bash
# Testar conexão com banco
curl http://localhost:3000/test-db

# Testar webhook
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"phone":"5511999999999","message":{"body":"DATA: HOJE..."}}'
```

## 🔧 Endpoints

- `GET /` - Health check
- `POST /webhook` - Webhook Z-API
- `GET /test-db` - Testar banco de dados

## 📊 Lógica de Rateio

### Divisão Igual (SIM)
- Área realizada dividida igualmente entre colaboradores

### Divisão Manual (NÃO)
- Usa valores específicos após os traços
- Se vazio, colaborador recebe 0

### Prêmios
- Palavra "PREMIO" = Recebe prêmio (R$ 30,00)
- Sem "PREMIO" = Não recebe

## 🚨 Monitoramento

Logs incluem:
- Mensagens recebidas
- Processamento OpenAI
- Inserções no banco
- Erros e exceções

## 📞 Suporte

Bot desenvolvido para automatizar boletins diários florestais com integração completa WhatsApp + IA + Banco de Dados.

---

*Desenvolvido para gestão florestal automatizada* 🌲
