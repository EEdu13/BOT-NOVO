# 🚀 INSTRUÇÕES DE DEPLOY - RAILWAY

## 📋 Passo a passo para fazer deploy:

### 1. Conectar ao Railway
1. Acesse [railway.app](https://railway.app)
2. Faça login com GitHub
3. Clique em "New Project" 
4. Selecione "Deploy from GitHub repo"
5. Escolha o repositório `BOT-NOVO`
6. Selecione o branch `clean-main`

### 2. Configurar Variáveis de Ambiente
No painel do Railway, vá em **Variables** e adicione:

```
DB_SERVER=alrflorestal.database.windows.net
DB_DATABASE=Tabela_teste  
DB_USER=sqladmin
DB_PASSWORD=SenhaForte123!
OPENAI_API_KEY=sk-proj-[SUA_CHAVE_OPENAI]
ZAPI_INSTANCE_ID=3E5222A62A81F1F54D49166DEAE7FD59
ZAPI_TOKEN=B8E1B4E1FA75141F36354BFD
ZAPI_CLIENT_TOKEN=Ff40cda6d962941f9bf447732c4564ec5S
ZAPI_BASE_URL=https://api.z-api.io/instances
PORT=3000
NODE_ENV=production
```

### 3. Deploy Automático
- O Railway irá automaticamente:
  - Detectar que é um projeto Node.js
  - Instalar dependências (`npm install`)
  - Iniciar o servidor (`npm start`)

### 4. Configurar Webhook na Z-API
Após o deploy, você receberá uma URL como:
```
https://bot-novo-production.up.railway.app
```

Configure o webhook na Z-API para:
```
https://bot-novo-production.up.railway.app/webhook
```

### 5. Testar
- Acesse `https://[sua-url]/` para verificar se está funcionando
- Envie uma mensagem de teste via WhatsApp

## 🔧 Comandos úteis:
- Ver logs: Painel do Railway > View Logs
- Redeploy: Painel do Railway > Deploy > Redeploy
- Variáveis: Painel do Railway > Variables

## ⚡ Pronto!
Seu bot estará rodando 24/7 no Railway!
