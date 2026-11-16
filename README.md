# Datamosh for Premiere Pro

Avidemux-style datamosh transitions as a Premiere Pro panel. Select clips with a cut
between them, click **MOSH IT**, and the moshed clip lands on the track above.

![Windows](https://img.shields.io/badge/platform-Windows-0078d4) ![Premiere Pro 25.6+](https://img.shields.io/badge/Premiere%20Pro-25.6%2B-9999ff) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Install (permanent)

Needs Windows, **Premiere Pro 25.6+** and the **Creative Cloud app**.

1. **Download:** click **Code > Download ZIP** above and unzip it, or run:

   ```bash
   git clone https://github.com/krugwalk/datamosh-premiere.git
   ```

2. **Put the folder somewhere you'll keep it**, e.g. `C:\Tools\datamosh-premiere`
   (not Downloads). The plugin runs from this folder, so don't move or delete it.
3. **Close Premiere Pro.**
4. **Double-click `setup.bat`.** It:
   - installs Python 3 if needed (asks first), plus two Python packages,
   - installs ffmpeg if needed (asks first),
   - installs the panel into Premiere with Adobe's own plugin installer,
   - makes the helper start hidden with Windows.
5. **Open Premiere Pro > Window > UXP Plugins > Datamosh.** The dot at the top right
   should say **helper online**.

It now stays installed like any other plugin: no UXP Developer Tools, nothing to load
each time.

## Use

1. Put two clips next to each other on a video track and select both.
2. Click **Use selection**, adjust settings (hover any setting to see what it does).
3. Click **MOSH IT**. The result is saved to `Datamosh Renders` next to your project
   and placed on the track above.

Moshing looks best when the incoming clip has lots of movement.

## Update

Replace the files in the same folder with the new version (or `git pull`), close
Premiere, and run `setup.bat` again.

## Uninstall

Close Premiere, run `uninstall.bat`, then delete the folder.

## Troubleshooting

| Problem | Fix |
|---|---|
| Not under **Window > UXP Plugins** | Restart Premiere. It needs Premiere Pro 25.6 or newer. |
| `Failed to install` during setup | Close Premiere, make sure the Creative Cloud app is installed and signed in, run `setup.bat` again. |
| Panel says **helper offline** | Click **Start helper** in the panel, or run `setup.bat` again. Errors are in `app\helper.log`. |
| `Could not find ffmpeg` | Run `setup.bat` again and let it install ffmpeg. |
| You moved the folder | Run `setup.bat` again from the new place. |

Why a helper? Premiere panels can't run programs like ffmpeg, so a small helper in
`app\` does the encoding. It only listens on `127.0.0.1` (your own computer).

## License

MIT, see [LICENSE](LICENSE).
