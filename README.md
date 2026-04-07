# Irregular - Accounts Receivable Tracker

## Deploy no Vercel (como fazes com o Dashboard Apolonia)

### 1. Criar repositório no GitHub
- Vai a github.com → New Repository → nome: `irregular-tracker`
- Faz upload de todos estes ficheiros para o repo

### 2. Criar ficheiro .env.local
Cria o ficheiro `.env.local` na raiz do projeto com:
```
NEXT_PUBLIC_SUPABASE_URL=https://vmjnmfztkuppnygnzujv.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_l0USM-O2cW-EyaILod4ilA_91SVEr1-
```

### 3. Deploy no Vercel
- Vai a vercel.com → Import Project → seleciona o repo
- Em Environment Variables, adiciona as mesmas variáveis do .env.local
- Deploy!

### Para correr localmente
```bash
npm install
npm run dev
```
Abre http://localhost:3000
