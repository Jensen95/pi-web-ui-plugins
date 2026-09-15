# Image Toolkit

Image Toolkit is an image workbench combining compression, cropping, resizing, rotation, format conversion, batch export, watermarking, and filters on one canvas. It reads and writes workspace images and provides four AI tools: `image_info`, `image_transform`, `image_compress`, and `image_watermark`.

Processing runs in the browser with Canvas. The plugin supports workspace import/export, drag-and-drop, clipboard paste, ZIP export, per-image settings, undo/redo, crop shapes, resizing, filters, metadata and EXIF inspection, and text or image watermarks. Server-side processing supports PNG, JPEG and BMP; JPEG processing may install the pure-JavaScript `jpeg-js` package.

Install it with `pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/image-toolkit --build`, which builds this source-only
plugin on the host. For local development:

```sh
npm run build:image-toolkit
pi-web-ui install plugins/image-toolkit
```

The generated server and browser entries are intentionally ignored; edit `src/` and rebuild after changes.
