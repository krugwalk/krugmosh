# Krugmosh for Premiere Pro

Avidemux-style datamosh transitions as a Premiere Pro panel. Select clips with a cut
between them, click **MOSH IT**, and the moshed clip lands on the track above.

![Windows](https://img.shields.io/badge/platform-Windows-0078d4) ![Premiere Pro 25.6+](https://img.shields.io/badge/Premiere%20Pro-25.6%2B-9999ff) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Install (permanent)

Needs Windows, **Premiere Pro 25.6+** and the **Creative Cloud app**. Get both files
from the **[latest release](https://github.com/krugwalk/krugmosh/releases/latest)**.

### 1. The panel: `krugmosh.ccx`

Download **`krugmosh.ccx`** and double-click it. Creative Cloud opens and installs it
like any Adobe Marketplace plugin. Restart Premiere Pro and open
**Window > UXP Plugins > Krugmosh**. It stays installed for good.

### 2. The helper: `Krugmosh-Helper.zip` (once)

Premiere plugins aren't allowed to run programs like ffmpeg, so a small helper does
the encoding. It only listens on `127.0.0.1` (your own computer).

1. Download **`Krugmosh-Helper.zip`** and unzip it somewhere you'll keep it,
   e.g. `C:\Tools\Krugmosh-Helper` (not Downloads). Don't move it afterwards.
2. Double-click **`install-helper.bat`**. It installs Python 3 and ffmpeg if they're
   missing (asks first), and starts the helper hidden, now and with every Windows start.

The dot at the top right of the panel should now say **helper online**.

## Use

1. Put two clips next to each other on a video track and select both.
2. Click **Use selection**, adjust settings (hover any setting to see what it does).
3. Click **MOSH IT**. The result is saved to `Krugmosh Renders` next to your project
   and placed on the track above.

Moshing looks best when the incoming clip has lots of movement.

## Update

Double-click the new `krugmosh.ccx`. If the release says the helper changed too, unzip
the new `Krugmosh-Helper.zip` over the old folder and run `install-helper.bat` again.

## Uninstall

Remove the panel in the Creative Cloud app (**Stock & Marketplace > Plugins > Manage
plugins**), run `uninstall.bat` in the helper folder, then delete that folder.

## Troubleshooting

| Problem | Fix |
|---|---|
| Not under **Window > UXP Plugins** | Restart Premiere. It needs Premiere Pro 25.6 or newer. |
| `krugmosh.ccx` won't install | Make sure the Creative Cloud app is installed and signed in, close Premiere, double-click it again. |
| Panel says **helper offline** | Click **Start helper** in the panel, or run `install-helper.bat` again. Errors are in `app\helper.log` in the helper folder. |
| `Could not find ffmpeg` | Run `install-helper.bat` again and let it install ffmpeg. |
| You moved the helper folder | Run `install-helper.bat` again from the new place. |

### Building from source

`powershell -File app\scripts\plugin_tools.ps1 release` builds both release files into
`app\build\release`. `plugin_tools.ps1 install` installs the panel straight from this
folder.

## License

MIT, see [LICENSE](LICENSE).
