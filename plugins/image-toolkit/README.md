# Image Toolkit

Image Toolkit is an image workbench combining compression, cropping, resizing, rotation, format conversion, batch export, watermarking, and filters on one canvas. It reads and writes workspace images and provides four AI tools: `image_info`, `image_transform`, `image_compress`, and `image_watermark`.

Processing runs in the browser with Canvas. The plugin supports workspace import/export, drag-and-drop, clipboard paste, ZIP export, per-image settings, undo/redo, crop shapes, resizing, filters, metadata and EXIF inspection, and text or image watermarks. Server-side processing supports PNG, JPEG and BMP; JPEG processing may install the pure-JavaScript `jpeg-js` package.

On narrow screens (viewport 640px or less) the three columns stack vertically: the queue becomes a horizontal thumbnail strip at the top, the stage keeps the remaining height, and the settings column turns into a bottom drawer. The grip above the tabs collapses the drawer down to the tab and action rows, and tapping any tab expands it again. Touch devices get larger crop handles, sliders, and checkboxes. The wide-screen layout is unchanged.

## Settings (the ⚙ button at the top right of the 🖼 view)

The configuration lives in the plugin's own storage, **not** in the host's ⚙ settings panel (this plugin no longer
appears there). Open the 🖼 view and use the ⚙ button at the top right; changes are saved immediately. Values saved
under the old declarative settings model are migrated automatically the first time the plugin loads.

| Item                                    | Default | Notes                                                                      |
| --------------------------------------- | ------- | -------------------------------------------------------------------------- |
| Default output format                   | keep    | Initial format for newly imported images (keep = follow the source)        |
| Default quality                         | 0.82    | Only JPEG/WebP/AVIF use it                                                 |
| Long-edge cap                           | 0       | When non-zero, newly imported images default to this long edge             |
| Output filename suffix                  | -min    | Appended when exporting or saving to the workspace                         |
| Overwrite same-name files               | off     | Off: same names get `-1`, `-2` suffixes, nothing is deleted                |
| Let the AI handle images                | on      | Off: the agent no longer sees the `image_*` tools (the view is unaffected) |
| Allow installing pure-JS codec packages | on      | Needed for server-side JPEG; off means the AI only handles PNG/BMP         |

Install it with `pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/image-toolkit --build`, which builds this source-only
plugin on the host. For local development:

```sh
npm run build:image-toolkit
pi-web-ui install plugins/image-toolkit
```

The generated server and browser entries are intentionally ignored; edit `src/` and rebuild after changes.
