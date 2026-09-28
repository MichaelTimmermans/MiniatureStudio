# MiniCamera — photo booth voor tabletop-miniaturen

Webapp (Flask + picamera2) voor een Raspberry Pi met camera, gemaakt om
miniaturen te fotograferen in een vaste photo booth: live preview, alle
camera-controls, foto/video, **focus stacking** met het meegeleverde
[focus-stack](https://github.com/PetteriAimonen/focus-stack), galerij en
(auto-)upload naar Google Drive of een NAS.

## Installeren

Op een Raspberry Pi met Raspberry Pi OS (Bookworm of nieuwer), als gewone gebruiker:

```bash
curl -fsSL https://git.timmermansmichael.be/Michael/MiniCamera/raw/branch/main/install.sh | bash
```

Of vanuit een clone:

```bash
git clone --recurse-submodules https://git.timmermansmichael.be/Michael/MiniCamera.git
cd MiniCamera && ./install.sh
```

De installer:

1. installeert de systeempakketten uit [`apt-packages.txt`](apt-packages.txt)
   (picamera2, Flask, OpenCV, ffmpeg, rclone, …);
2. cloont de app naar `/opt/minicamera` (of gebruikt je clone);
3. bouwt focus-stack uit `vendor/focus-stack` (git submodule) — op een Pi 3B
   duurt dat een kwartier of zo;
4. installeert de systemd-service `minicamera` (start automatisch bij boot).

Open daarna `http://<hostnaam>.local:8000`.

## Updaten

- In de webapp: **Instellingen → Controleer op updates → Update installeren**.
  De app herstart zelf.
- Of in een terminal: `minicamera-update` (`--check` om enkel te kijken).

Updates volgen de `main`-branch via `git pull`. Nieuwe systeempakketten of een
nieuwe focus-stack-versie worden automatisch meegenomen.

## Camera's

Aangesloten camera's worden bij het opstarten automatisch gedetecteerd
(`Picamera2.global_camera_info()`); kies de actieve camera in het tabblad
**Camera**. CSI-camera's zijn niet hot-pluggable: sluit ze aan met de Pi uit.
Controle: `rpicam-hello --list-cameras`.

Alle libcamera-controls van de camera verschijnen automatisch in de UI.
Instellingen worden per cameramodel onthouden.

### Autofocus-camera's (bv. Camera Module 3)

Als de camera `AfMode`/`LensPosition` ondersteunt:

- **Autofocus**-knop (één AF-cyclus, daarna wordt de lens vergrendeld in manual);
- **Lens-sweep**: stel start/einde-LensPosition (dioptrie: 0 = oneindig,
  hoger = dichterbij), aantal stappen en wachttijd in. De app neemt alle frames
  en stackt ze automatisch.
- Stacks worden altijd automatisch verwerkt (er is geen Process-knop; enkel
  "Opnieuw verwerken" als een run mislukte).

## Focus stacking

Frames van een stack komen in `stacks/<naam>/<naam>_1.png`, `_2.png`, …;
het resultaat is `<naam>_stacked.png`. De opties van focus-stack (consistency,
denoise, batchsize, uitlijning, dieptekaart, …) staan in **Instellingen** en
kunnen per run overschreven worden in het tabblad **Stacks**.

- `batchsize = 0` zet alle frames in één batch (beste kwaliteit, maar veel RAM:
  op een Pi 3B met 1 GB houd je dit best op 4).
- "Bronframes verwijderen na geslaagde stack" staat standaard aan; worden
  frames ook geüpload, dan gebeurt dat eerst.
- Tip voor een Pi 3B: vergroot de swap (`sudo nano /etc/dphys-swapfile`,
  `CONF_SWAPSIZE=2048`) als focus-stack stopt door geheugentekort.

## Bestandsnamen

Patroon met Python `str.format`-syntax, bv. `{dt:%Y%m%d_%H%M%S}_{label}` of
`{seq:04d}_{label}`. `{seq}` telt op na elk gebruik.

## Uploaden

- **Google Drive** via rclone: `rclone config` → remote `gdrive` aanmaken
  (headless: kies "n" bij auto config en volg de instructies). Stel het doel in
  bij Instellingen (standaard `gdrive:MiniCamera`). Is de remote aanwezig, dan
  gaan foto's, video's en verwerkte stacks er **automatisch** heen (uit te
  zetten).
- **NAS**: mount de share (bv. via `/etc/fstab`) en vul het pad in. De app weigert
  te kopiëren als het pad niet gemount is, zodat de SD-kaart niet volloopt.

## Ontwikkelen zonder Pi

```bash
pip install -r requirements.txt
python app.py --demo --port 8000
```

Demo-modus simuleert een camera (met AF, zodat de sweep te testen is).

## Hardware waarvoor dit gemaakt is

Raspberry Pi 3B, HQ Camera (IMX477), 5-50 mm CS-mount varifocal met macroring
(manuele focus), booth van 30×30×40 cm. Werk op F8: kleiner diafragma geeft op
deze sensor diffractie, focus stacking geeft méér scherptediepte.

## Licentie

focus-stack © Petteri Aimonen, MIT-licentie (zie `vendor/focus-stack/LICENSE.md`).
