# cluster-yandex-safearea-fix (Store source)

A one-tool [mgu Store](https://github.com/robertnisipeanu/mgu-store) source for
**cluster-yandex-safearea-fix**, an add-on to
[waze-on-cluster](https://github.com/robertnisipeanu/idrive-apps) that fixes the
CarPlay instrument-cluster **safe area for Yandex Maps** — the rectangle where
the phone keeps its guidance banner.

**Read this first.** The safe area is one rectangle for every CarPlay app, not
per-app. This tool moves it to where **Yandex Maps** needs it (504×368+433+72),
so it is right for Yandex Maps and **may misplace the banner on other apps**
(Apple Maps, Google Maps, Waze). Install it only if Yandex Maps is the navigator
you use on the cluster. It is reversible: removing it restores waze-on-cluster's
own safe area.

The tool, with its own README and the `safe=` offset in `safearea.conf`, is in
[`native/cluster-yandex-safearea-fix`](native/cluster-yandex-safearea-fix).

## Add it to the Store

This repository is a **repo tree** (`mgu-repo.json` at the root): the tool ships
as committed JavaScript, so the head unit needs no build step.

1. Install **waze-on-cluster** first and enable its map. This tool requires it
   (0.7.1 or newer — a newer version is fine).
2. In the Store, add this GitHub repository as a source (branch channel). The
   Store reads `mgu-repo.json`, lists **Yandex Maps cluster safe-area fix**, and
   installs it.
3. A restart pending is shown; the safe area takes effect at the next head-unit
   start, and is re-applied after each boot (a small root service) in case
   waze-on-cluster's Enable map / update reset it.

## License

GPL-3.0-or-later (`LICENSE`).
