# Strava Heatmap extension

This browser extension seamlessly integrates the [Strava Global Heatmap](https://www.strava.com/maps/global-heatmap) into popular mapping editors, including the OpenStreetMap [iD editor](https://www.openstreetmap.org/edit?editor=id), [GPX Studio](https://gpx.studio/app), and [CalTopo](https://caltopo.com/), enhancing your mapping and route analysis capabilities. In iD and Caltopo, [Strava Slide](#strava-slide-id) snaps a roughly drawn line onto the heatmap trail.

<img src="./images/screenshot1.png" width="48%"/>&nbsp;<img src="./images/screenshot2.png" width="48%"/>

## Pre-requisites

### Strava account

If you don’t already have a Strava account, you’ll need to create one (free) to use the Strava Heatmap.

1. Go to https://www.strava.com/register/free
2. Sign up using Google, Apple, Facebook, or your email

## Installation

### Chrome

Open the [Chrome extension page](https://chrome.google.com/webstore/detail/eglbcifjafncknmpmnelckombmgddlco) for the extension.

1. Click `Add to Chrome`.
2. Confirm permissions by selecting `Add extension`.
3. Chrome will briefly display a popup and show the new extension icon in the top-right toolbar.
4. Right-click the extension icon and choose `Pin` to keep it visible.
5. Alternatively, open the puzzle-piece Extensions menu and click the 📌 next to Strava Heatmap extension.

### Firefox

Open the [Firefox add-on](https://addons.mozilla.org/en-US/firefox/addon/strava-heatmap/) for the extension.

1. Click `Add to Firefox`.
2. Confirm permissions by selecting `Add`.
3. Firefox will briefly display a popup and show the new extension icon in the top-right toolbar.
4. Make sure `Pin extension to toolbar` is selected and click `OK`.
5. Alternatively, right-click the extension icon and choose `Pin` to keep it visible.

### Other browsers

The extension hasn't been tested or fully supported on other Chromium-based browsers like Brave and Opera.

### Versions

See the [Changelog](./CHANGELOG.md) for details.

### Building from source

With Node.js 20 or newer installed, run:

```sh
npm install
npm run build
```

The build works on Windows, macOS, and Linux without external shell or ZIP tools.
It creates Chrome and Firefox ZIP packages in `dist/` and an unpacked Chrome
extension in `dist/<version>-chrome/`. In Chrome's extension manager, enable
Developer mode and use **Load unpacked** to select that folder.

To build only the CalTopo integration, run:

```sh
npm run build -- --caltopo-only
```

This creates `dist/<version>-caltopo-only-chrome.zip`,
`dist/<version>-caltopo-only-firefox.zip`, and the unpacked Chrome extension in
`dist/<version>-caltopo-only-chrome/`, without replacing the full builds.
These packages omit the iD and GPX.studio integrations and their site permissions,
but retain Strava authentication, settings, and the shared snapping modules needed
by CalTopo.

### Icon artwork

The CalTopo fork's source icon is [icons/icon.svg](./icons/icon.svg): a flaming
compass designed for 48 x 48 and 128 x 128 pixels, in color or grayscale.
It is a self-contained SVG with a transparent background and no external fonts
or images. The existing PNG icons remain unchanged; SVG-to-PNG generation will
be added separately.

### Instructions

## OpenStreetMap iD editor

To enable the Strava Heatmap in the iD editor:

1. Open the iD editor: https://www.openstreetmap.org/edit?editor=id
2. Press B or click Background settings, then scroll to Overlays.
3. Select a Strava Heatmap overlay from the list.
4. If you see the message "Click the Strava Heatmap extension icon to log into Strava…", click the red extension icon to authenticate.
5. After logging in, use the extension icon to configure heatmap layers: choose activity type and color, and manage layer order or deletion.
6. In the editor, press Shift + Q to toggle all overlays (including the heatmap), and Shift + W to toggle data visibility.

### Strava Slide (iD)

https://github.com/user-attachments/assets/0b53814f-94b8-4ed1-9380-0b048f3b9e37

With a Strava Heatmap overlay switched on and the extension signed in, an existing line can be snapped to the closest trace of that heatmap. Inspired by [Paul Mach's Slide](https://github.com/paulmach/slide/) and [Strava's iD integration](https://github.com/strava/iD).

1. Log into Strava with the extension and enable a Strava heatmap overlay.
2. Draw a rough line along the trail, or select an existing line. It can start and end on other roads or paths: those junctions stay in place, and the line is traced into them.
3. Press **Shift + S** (also right after drawing), or right-click the selected line and choose **Slide**.
   To slide only part of a way, select two or more of its points instead.
4. If several Strava overlays are enabled, choose the activity to follow.
5. Review the result before saving. Use iD's normal **Undo** to restore the original line.

What Slide changes:

- The line's first and last points, junctions with other ways, tagged nodes (fords, gates, crossings…) and relation members stay in place: to move one, disconnect it or move it by hand first.
- Where the line meets another road or path, it does not run along it. The heat of other mapped roads and paths is ignored, so a stronger parallel trail does not pull the line onto it.
- Sections with no usable heatmap trail are left as drawn, and the rest is slid. A message tells you how many.
- Near-duplicate points, tiny kinks and spikes are removed. Only untagged nodes not used by anything else are ever deleted.
- Bridges and tunnels themselves are not slid.

#### Known issues

Feedback and test cases are collected in [#43](https://github.com/julcnx/strava-heatmap-extension/issues/43). Always review the result before saving.

- **Parallel trails:** the heat within a few metres of other mapped roads and paths is ignored, and a section that would detour onto another heat trace is left as drawn. A point drawn closer to a stronger trail than to its own can still snap onto it. Workaround: Undo and slide only the sections around it (select two points: the selected end points stay in place), then fix that part by hand. Next step: snap to the closest trail rather than the strongest.
- **Tight switchbacks:** where the legs of a tight switchback merge into one band of heat, Slide cannot see the tip and cuts it short. Workaround: slide the line up to the switchback and from it (select two points), or move the tip by hand. Next step (v0.16.0): keep drawn tips where the heat cannot show them.
- **"Slide needs too many tiles":** the box around the line must fit in 16 heatmap tiles (about 4 × 4 km, less at high latitudes), so long or diagonal lines are refused. Workaround: select two points and slide the line in sections. Next step (v0.16.0): split long lines into sections automatically, with one Undo.

The extension's shortcuts are also listed in iD's keyboard shortcuts panel (**?**).

### GPX.studio editor

To enable the Strava Heatmap in GPX.studio:

1. Open GPX.studio: https://gpx.studio/app
2. Hover over the layers menu icon, then scroll to Overlays.
3. Choose a Strava Heatmap overlay from the list.
4. If you see the message "Click the Strava Heatmap extension icon to log into Strava…", click the red extension icon to authenticate.
5. Once logged in, use the green extension icon to configure, reorder, or delete heatmap layers by activity and color.

### CalTopo

To enable the Strava Heatmap in CalTopo:

1. Open a map at https://caltopo.com/.
2. In the Map Layers panel to the right of the map, under "Route Discovery", toggle the Strava Heatmap layer. Select a configured layer, toggle it, or adjust its opacity.
3. Use the extension icon to log into Strava and configure the available heatmap layers.

#### Snap drawing segments to Strava

1. Sign into Strava using the extension and select the activity layer in the Strava heatmap controls.
2. Choose **Add > Line**, **Polygon**, or **Buffer** (and enter its radius), then select **Strava** in the map's **Snap To** dropdown. The measure tool also supports Strava snapping.
3. Click along the heatmap trail in short sections. After each click, wait for the segment to finish tracing before adding the next point. The clicked endpoints stay in place; the segment between them follows the heat centerline.
4. Use CalTopo's normal **Undo** (or **Esc**) to remove a segment, and finish or save normally. CalTopo still handles polygon closing and buffer geometry. To snap a polygon's final edge too, click back on its starting point before finishing.

Snapping uses the selected Strava activity and palette, even if the overlay is hidden.
Keep clicks close to the desired trail, with extra points around bends and forks.
This follows nearby heat, not a routable trail network: it cannot plan long routes
across gaps or distant turns. Missing heat, expired login, or an oversized segment
shows an error beside **Snap To** and leaves the line unchanged. Select **None** to
draw across a gap, or choose **OSM** to return to CalTopo's normal routing.

### Troubleshooting

**Q: “Click the Strava Heatmap extension icon to log into Strava and enable the heatmap.” — What does this mean?**  
**A:** This message appears if you're not logged in to Strava AND haven’t visited the [Strava Global Heatmap](https://www.strava.com/heatmap). Just click the extension icon to sign in and authorize access.

### Feature and Bug Requests

Submit issues and feature requests in the [Issues](https://github.com/tjasz/strava-heatmap-extension/issues) section above.

## Extension Background

Previously, accessing Strava heatmap in OpenStreetMap iD editor required a tedious process of extracting Strava website cookies and generating a temporary URL that would expire after a week.

The [JOSM Strava Heatmap Extension](https://github.com/zekefarwell/josm-strava-heatmap) simplified this process, but due to the lack of support for custom overlays in the iD editor, users could only add the URL as a custom background.

With this extension, you can now automatically access all Strava activities as Heatmap overlays, eliminating the need for manual URL management.

To learn more about using the Strava Heatmap in OpenStreetMap, visit the [Strava wiki](https://wiki.openstreetmap.org/wiki/Strava).

### Support for Other Sites

This extension currently supports the iD editor, [gpx.studio](https://gpx.studio), and [CalTopo](https://caltopo.com/). I'm not taking on additional sites at the moment. If you'd like to add support for another tool, feel free to fork the project.

- For JOSM, check out the [JOSM Strava Heatmap Extension](https://github.com/zekefarwell/josm-strava-heatmap).
- For RapidId, refer to the [RapId Power User Extension](https://github.com/emersonveenstra/rapid-power-user-extension/).
