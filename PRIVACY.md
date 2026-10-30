# Privacy Policy

Strava Heatmap for CalTopo does not collect analytics or send user data to the extension developer.

## Firefox data consent

Firefox asks for consent to transmit authentication information (Strava cookies)
and location information (requested map tile coordinates). These are declared as
required data permissions because they support the extension's heatmap functionality.
The extension uses Firefox's built-in consent on desktop version 140 and later
and Android version 142 and later; older Firefox versions are not supported.

## Local storage and authentication

The extension reads Strava authentication cookies and stores a local copy in your browser to authenticate requests for protected Strava Global Heatmap tiles. These credentials are sent to Strava for heatmap access, not to the extension developer.

The extension also stores your heatmap layer preferences and temporary sign-in navigation information locally in your browser. It can remove Strava authentication cookies when they expire or when you select "Clear Strava Cookies."

## External requests

The extension connects to Strava for sign-in and heatmap tiles. Tile requests include the coordinates of the requested map tiles, which identify the map area being viewed or processed.

When signed out, the extension loads a fallback image from GitHub's raw content service. These image requests also include map tile coordinates.

When you select **Map Sheet from Strava Heatmap** in CalTopo, the extension
downloads the heatmap tiles covering your view and uploads a colorized image,
its geographic coordinates, and an activity/color/timestamp title to CalTopo.
These requests use your existing CalTopo sign-in session to save a private map
sheet to your account and add it to the current map. Public sharing is always
disabled. The extension does not read or store your CalTopo authentication
cookies; the browser sends them with same-origin requests. CalTopo's handling
of these uploads is governed by its privacy policy.

As with other web requests, Strava and GitHub receive your IP address and standard request information. Their handling of these requests is governed by their respective privacy policies.
