# Testing The Hosted Add-On

## What testers need

- Access to the Trimble Connect 3D viewer.
- At least one IFC or LandXML model loaded in the viewer.
- The hosted GitHub Pages panel URL for this repository.

Default URL pattern:

`https://<github-owner>.github.io/trimble-connect-add-on/index.html`

If the repository name changes, replace `trimble-connect-add-on` with the actual repository name. The exact deployed URL is also shown in the GitHub Actions deployment summary.

## How to open the hosted app in Trimble Connect

1. Open Trimble Connect and enter a project with the 3D viewer available.
2. Register or open a custom add-on panel using the hosted GitHub Pages URL.
3. Use the hosted panel URL, not the local development manifest URL.
4. Open the add-on inside the Trimble Connect 3D viewer.

Optional hosted manifest:

`https://<github-owner>.github.io/trimble-connect-add-on/manifest.hosted.json`

That manifest is generated during deployment and points the panel URL at the hosted `index.html`.

## Expected behavior

When the panel opens inside Trimble Connect:

- the app should connect to the viewer,
- loaded IFC and LandXML files should be detected,
- the alignment dropdown should populate after refresh,
- labels should be placeable on the selected alignment,
- clipping should work for a chainage range.

## Troubleshooting

- If the page opens in a normal browser tab, the UI can load but Trimble Connect viewer operations will stay unavailable until the app is opened inside Trimble Connect.
- If no models are detected, confirm IFC or LandXML files are actually loaded and visible in the current viewer session.
- If labels or clipping fail, refresh the alignment list after the viewer finishes loading the models.
