# PaddockAI — App Store Build Guide

## App ID: ai.paddock.app
## Bundle: ai.paddock.app

## Når klar til iOS/Android build:

```bash
# 1. Installer Capacitor CLI
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android

# 2. Tilføj platforme
npx cap add ios
npx cap add android

# 3. Sync web assets
npx cap sync

# 4. Åbn i Xcode (iOS)
npx cap open ios

# 5. Åbn i Android Studio
npx cap open android
```

## Kræver:
- Apple Developer konto (99 USD/år) → appleid.apple.com
- Android Developer konto (25 USD engangsbetaling) → play.google.com/console

## App Store info klar:
- Navn: PaddockAI
- Kategori: Sports
- Beskrivelse: Hold styr på dine ryttere til stævner
- Domæne: paddockai.com
