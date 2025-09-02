# 🚀 INSTRUÇÕES DE DEPLOY - RAILWAY

## 📋 Passo a passo para fazer deploy:

### 1. Conectar ao Railway
1. Acesse [railway.app](https://railway.app)
2. Faça login com GitHubd
3. Clique em "New Project" 
4. Selecione "Deploy from GitHub repo"
5. Escolha o repositório `BOT-NOVO`
6. Selecione o branch `clean-main`

### 2. Configurar Variáveis de Ambiente
No painel do Railway, vá em **Variables** e adicione:

```
DB_SERVER=seu_servidor.database.windows.net
DB_DATABASE=nome_do_banco
DB_USER=usuario_banco
DB_PASSWORD=senha_banco
OPENAI_API_KEY=sua_chave_openai_aqui
ZAPI_INSTANCE_ID=sua_instance_id
ZAPI_TOKEN=seu_token
ZAPI_CLIENT_TOKEN=seu_client_token
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
