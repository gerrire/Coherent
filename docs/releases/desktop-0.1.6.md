# Coherent Desktop 0.1.6

- Replace the polling-based window move loop with native Win32 caption hit surfaces. Windows handles dragging, restore-on-drag and snapping without a JavaScript/IPC loop.
- Add a native `HTMAXBUTTON` surface for Windows 11 Snap Layouts, sized at 46 × 36 logical pixels. Reposition after window/DPI changes, keep the resize border free, and hide native surfaces when the React titlebar is hidden for screen viewing.
- Lower the minimum window size to 480 × 420 so half/quarter layouts can use the existing compact navigation.
- Add a titlebar update button with a themed update panel. It uses the existing signed update workflow and still blocks installation during calls.
- Refresh the titlebar in every theme. Add combined process, private memory and CPU metrics under client settings; WebView2 process IDs are deduplicated across auxiliary windows.
- Position message edit/delete actions at the left centre of the bubble, with below/above fallbacks and viewport clamping. Render outside the scrolling message list to avoid clipping.

Windows Task Manager owns visual grouping of WebView2 processes. There is no supported WebView2 API to force all of them into one entry; a process AppUserModelID does not fix this Windows/runtime issue. The settings counters provide a combined view without disabling process isolation.

Validation: frontend production build; 13 focused tests (message menu geometry, update safety, settings); Windows Rust/C++ release build and signed NSIS installer. Interactive window/Snap checks remain unverified: the execution policy rejected launching the locally built client, including after explicit user approval. This build has not been installed, pushed, published or deployed to the web service.
