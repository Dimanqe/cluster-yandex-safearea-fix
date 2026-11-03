# cluster-yandex-safearea-fix

A small reversible add-on tool for [waze-on-cluster](https://github.com/robertnisipeanu/idrive-apps)
on a BMW iDrive 7 head unit (MGU) that **fixes the CarPlay instrument-cluster
safe area for Yandex Maps**.

## What it fixes

waze-on-cluster advertises the cluster map at 1088×480 and sets its own default
**safe area** — the rectangle where the phone is told to keep its guidance UI
(the next-turn banner, etc.) so it stays clear of the gauges. With **Yandex
Maps** that default (x = 286) puts the banner in the wrong place. This tool
moves the safe area to **504×368+433+72**, tuned for Yandex Maps.

**The safe area is one rectangle for every CarPlay app.** It is not per-app, so
this offset applies to all of them: it is right for Yandex Maps and **may
misplace the banner on other apps** (Apple Maps, Google Maps, Waze). Install it
only if Yandex Maps is the navigator you use on the cluster.

## Why it is a separate tool with a boot service

The safe area lives inside waze-on-cluster's own resolution patch (edit 4), and
waze-on-cluster rewrites that region back to its default on every **Enable map**
and on every update. So this fix cannot be a one-time patch: a small root
service re-applies the Yandex safe area **once after each boot**, after
waze-on-cluster's patch daemon has settled. The change takes effect at the next
head-unit start, the same way waze-on-cluster works.

It writes only the two 8-byte safe-area immediates of the IC_HIGH geometry
builder (found by structure, not fixed address) and keeps a backup of exactly
those bytes. The backup is stamped with the carplay binary it came from (build-id
and size): a waze-on-cluster update or Enable map keeps the same binary, so the
backup stays valid, but a BMW firmware update replaces carplay with a different
binary — then, on the next apply, the tool takes a fresh backup of the new
binary's original bytes before re-applying the offset, and overwrites the old
backup (one backup file, no stale copies). So removing the tool always restores
whatever the current carplay shipped with. If it is ever asked to take a first
backup while the safe area already reads as its own wanted value (e.g. the backup
was deleted by hand while the offset was applied), it refuses rather than record
its own edit as the original — restore waze-on-cluster's safe area first (Enable
map) and apply again. It refuses unless waze-on-cluster's
resolution patch is active (physical size 138×61 mm), so it never rewrites a
stock geometry. It never stops, kills, restarts or reboots CarPlay. Proven on
carplay `22.28.3` (build-id `5de62156…`).

## The offset

Default: **504×368+433+72** in the 1088×480 cluster frame. Change it without
editing shipped files by writing a line to
`/var/opt/cluster-yandex-safearea-fix/safearea.local.conf`:

```
safe=504x368+433+72
```

(updates overwrite the shipped `safearea.conf`, but keep `safearea.local.conf`).

## Install and remove

Install **after** waze-on-cluster and enable its map first. The deploy tool runs
`safearead.js activate`; the Store shows a restart pending, and the safe area
takes effect at the next head-unit start. Remove it in the Store;
`safearead.js deactivate` restores the safe area from its backup.

**What "restores" means.** At the first install the tool backs up the safe area
as it is **at that moment** (`/usr/bin/carplay.woc-safearea.json`), and removal
puts exactly that back. If the safe area was already changed by hand before the
install (e.g. already 433), removal returns that value, not waze-on-cluster's
default 286. To have removal return 286, press **Enable map** in the
waze-on-cluster app before installing this tool.

**Remove it while the map is on.** If you turn the map off (Disable map, which
puts back the stock 1920×900 geometry) and then remove this tool, the removal
writes the backed-up 1088×480 safe area over the stock geometry, leaving it
inconsistent. Remove this tool first, or press Enable map again before removing
it.

## From a shell

```sh
node safearea_patch.js status                         # show current and wanted safe area
node safearea_patch.js apply  --yes                   # apply 504x368+433+72 (or the conf's)
node safearea_patch.js apply  --safe 504x368+420+72 --yes   # a different offset
node safearea_patch.js reconcile --yes                # re-apply if waze-on-cluster reset it
node safearea_patch.js revert --yes                   # restore waze-on-cluster's safe area
node safearea_patch.js verify                         # exit 0 when set
```

## License

GPL-3.0-or-later (`LICENSE`). Derived from waze-on-cluster
(`carplay_locate.js`, `remount_lock.js`), Copyright (C) 2026 Robert Nisipeanu,
also GPL-3.0-or-later.
