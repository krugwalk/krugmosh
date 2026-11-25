# Krugmosh for Premiere Pro

Avidemux-style datamosh transitions as a Premiere Pro panel. Select clips with a cut
between them, click **MOSH IT**, and the moshed clip lands on the track above.

![Windows](https://img.shields.io/badge/platform-Windows-0078d4) ![Premiere Pro 25.6+](https://img.shields.io/badge/Premiere%20Pro-25.6%2B-9999ff) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Install

Needs Windows, **Premiere Pro 25.6+** and the **Creative Cloud app**.

1. Download **`Krugmosh-Setup.exe`** from the
   **[latest release](https://github.com/krugwalk/krugmosh/releases/latest)**.
2. Close Premiere Pro, run it and click **Install**.
3. Open Premiere Pro, then **Window > UXP Plugins > Krugmosh**. The dot at the top
   right of the panel should say **helper online**.

The installer puts the panel into Premiere (through Adobe's own plugin installer),
installs Python 3 and ffmpeg with winget if they're missing, and starts a small helper
in the background, now and with every Windows start. Premiere plugins aren't allowed to
run programs like ffmpeg, so the helper does the encoding; it only listens on
`127.0.0.1` (your own computer). No admin rights needed.

## Use

1. Put two clips next to each other on a video track and select both.
2. Click **Use selection**, adjust settings (hover any setting to see what it does).
3. Click **MOSH IT**. The result is saved to `Krugmosh Renders` next to your project
   and placed on the track above.

Moshing looks best when the incoming clip has lots of movement.

## Update

Run the new `Krugmosh-Setup.exe` and click **Install** again.

## Uninstall

Run `Krugmosh-Setup.exe` and click **Uninstall**. It removes the panel, stops the helper
and deletes its files. Python and ffmpeg are left installed.

## Troubleshooting

| Problem | Fix |
|---|---|
| Not under **Window > UXP Plugins** | Restart Premiere. It needs Premiere Pro 25.6 or newer. |
| Setup says Adobe's installer wasn't found | Install and sign in to the Creative Cloud app, close Premiere, run setup again. |
| Panel install failed | Close Premiere Pro and click **Install** again. |
| Panel says **helper offline** | Click **Start helper** in the panel, or run `Krugmosh-Setup.exe` again. Errors are in `%LOCALAPPDATA%\Krugmosh\helper\helper.log`. |
| `Could not find ffmpeg` | Run `Krugmosh-Setup.exe` again; it installs ffmpeg if it's missing. |

### Building from source

`powershell -File setup\build.ps1` builds `build\Krugmosh-Setup.exe` (the panel and the
helper are embedded; it only needs the C# compiler that ships with Windows).
`powershell -File app\scripts\plugin_tools.ps1 install` installs just the panel straight
from this folder.

## License

MIT, see [LICENSE](LICENSE).
