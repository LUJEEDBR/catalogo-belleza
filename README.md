# Catálogo Belleza · PWA (Fase 1)
Sin build: HTML + JS. Sube esta carpeta a la raíz del repo LUJEEDBR e impórtalo en Vercel (Framework: Other, sin comando de build).
- config.js: URL y llave publicable de Supabase.
- app.js: login, escáner (BarcodeDetector / ZXing), autollenado Open Beauty Facts, foto WebP 600px, guardado.
- sw.js: la app abre sin internet y guarda las fotos en caché.
- Ventas: pestaña Vender (carrito, cobro, venta sin código por foto) y Ventas (reporte por día, hora y más vendidos). Requiere sql/02_ventas.sql.
- db.js + sync.js: copia local del catálogo y cola offline en IndexedDB; sube en orden al volver el internet (último cambio gana; precios solo dueña).
La cámara necesita HTTPS (Vercel ya lo da).
