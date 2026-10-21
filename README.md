# Baixador de Imagens

App de desktop para Windows que encontra e baixa imagens em alta resolução de galerias, fóruns, páginas e buscas.

## Instalar e abrir

Rode `dist\Baixador-de-Imagens-Setup-1.1.0.exe`. A instalação é por usuário (sem administrador) e cria atalhos na Área de Trabalho e no Menu Iniciar. Para desinstalar: Configurações do Windows → Aplicativos.

## Como usar

1. Cole o link de uma página (ou vários, um por linha) e clique em **Escanear**, ou troque para **Buscar** e digite um termo. Também dá para arrastar um link para a janela.
2. Clique numa foto para vê-la em tela cheia; clique no círculo para marcar ou desmarcar (Shift+clique seleciona um intervalo).
3. Filtre por **Tamanho** (HD, Full HD, 4K…), **Tipos** e **Origem**.
4. Clique em **Baixar**. A pasta de destino fica ao lado do botão.

Atalhos: `Enter` escaneia · `Shift+Enter` nova linha · `Ctrl+L` vai para a barra · `Ctrl+A` seleciona tudo · `Ctrl+S` baixa · `Esc` fecha/cancela · no visualizador, `←` `→` navegam e `Espaço` seleciona.

## O que ele faz

- **Maior resolução automática**: mede cada imagem pelo cabeçalho do arquivo e testa versões maiores (atributos de zoom, `srcset`, sufixos do WordPress, pastas de miniaturas, parâmetros de redimensionamento e regras de Wikimedia, Bing, Google/Blogger, X, Tumblr, Imgur, Pinterest, Flickr, Reddit, Shopify, Cloudinary, Amazon e YouTube). Recusa versões "esticadas" pelo servidor.
- **Páginas de imagem**: segue cada miniatura até a página dela e escolhe a foto principal por pontuação heurística combinada com o tamanho real.
- **Páginas em JavaScript**: abre galerias montadas por JavaScript, com rolagem infinita ou "carregar mais", num navegador invisível (usa o Microsoft Edge já instalado).
- **Fóruns e galerias com várias páginas**, **sequências** (`foto[001-120].jpg`), **vídeos**, **sites com senha** (autenticação HTTP) e **busca** no Bing e no DuckDuckGo.
- **Downloads** paralelos (até 50), com validação, novas tentativas, retomada e limite por site; nomes por modelo (`{name}`, `{n}`, `{title}`, `{host}`) e subpastas.
- **Exportar** código HTML ou BBCode e copiar links.

## Para desenvolver

```
npm install
npm start          # abre o app em modo de desenvolvimento
npm run icon       # regenera build/icon.ico a partir de build/icon.svg
npm run dist       # gera o instalador em dist/
```

Estrutura: `main.js` (janela e ponte segura), `preload.js`, `app/` (interface), `core.js` (motor: escaneamento, medição, downloads), `render.js` (navegador invisível). `web-legacy/` e o modo `node core.js` existem só para os testes automatizados do motor.
