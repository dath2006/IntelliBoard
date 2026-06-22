#!/usr/bin/env python3
"""Download Raspberry Pi 3B boot files needed for QEMU emulation.

Files downloaded:
  kernel8.img             — 64-bit kernel from RPi firmware repo
  bcm271~1.dtb            — Device Tree Blob (bcm2710-rpi-3-b.dtb, short name for Windows compat)
  <raspios-lite>.img.xz   — Raspberry Pi OS Lite (armhf) SD image, extracted in place

The SD image (~500 MB compressed, ~2 GB extracted) is the largest download.
It is placed in img/ and the emulator picks it up automatically.
"""
import lzma
import os
import sys
import urllib.request

KERNEL_URL = "https://github.com/raspberrypi/firmware/raw/master/boot/kernel8.img"
DTB_URL    = "https://github.com/raspberrypi/firmware/raw/master/boot/bcm2710-rpi-3-b.dtb"

# Raspberry Pi OS Lite (armhf) — Trixie release.
# Check https://downloads.raspberrypi.com/raspios_lite_armhf/images/ for the latest.
SD_IMAGE_DATE = "2025-12-04"
SD_IMAGE_XZ   = f"{SD_IMAGE_DATE}-raspios-trixie-armhf-lite.img.xz"
SD_IMAGE_IMG  = f"{SD_IMAGE_DATE}-raspios-trixie-armhf.img"
SD_IMAGE_URL  = (
    f"https://downloads.raspberrypi.com/raspios_lite_armhf/images/"
    f"raspios_lite_armhf-{SD_IMAGE_DATE}/{SD_IMAGE_XZ}"
)

REPO_ROOT  = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMG_DIR    = os.path.join(REPO_ROOT, "img")

KERNEL_PATH   = os.path.join(IMG_DIR, "kernel8.img")
DTB_PATH      = os.path.join(IMG_DIR, "bcm271~1.dtb")
SD_XZ_PATH    = os.path.join(IMG_DIR, SD_IMAGE_XZ)
SD_IMAGE_PATH = os.path.join(IMG_DIR, SD_IMAGE_IMG)


def _progress_bar(downloaded: int, total: int) -> None:
    if total > 0:
        pct = downloaded / total * 100
        mb_done = downloaded / 1_048_576
        mb_total = total / 1_048_576
        sys.stdout.write(f"\r  {pct:5.1f}%  {mb_done:.1f} / {mb_total:.1f} MB")
        sys.stdout.flush()


def download_file(url: str, dest: str) -> bool:
    print(f"\nDownloading:\n  {url}\n  -> {dest}")
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        )
        with urllib.request.urlopen(req) as resp:
            total = int(resp.info().get("Content-Length", 0))
            downloaded = 0
            block = 65536
            with open(dest, "wb") as f:
                while True:
                    chunk = resp.read(block)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    _progress_bar(downloaded, total)
        print()
        return True
    except Exception as exc:
        print(f"\n  ERROR: {exc}")
        if os.path.exists(dest):
            os.remove(dest)
        return False


def extract_xz(src: str, dest: str) -> bool:
    size_mb = os.path.getsize(src) / 1_048_576
    print(f"\nExtracting {src} ({size_mb:.0f} MB) ...")
    try:
        with lzma.open(src, "rb") as xf, open(dest, "wb") as out:
            written = 0
            block = 1 << 20  # 1 MB
            while True:
                chunk = xf.read(block)
                if not chunk:
                    break
                out.write(chunk)
                written += len(chunk)
                sys.stdout.write(f"\r  Written: {written / 1_048_576:.0f} MB")
                sys.stdout.flush()
        print(f"\n  Done. Image size: {written / 1_073_741_824:.2f} GB")
        return True
    except Exception as exc:
        print(f"\n  ERROR during extraction: {exc}")
        if os.path.exists(dest):
            os.remove(dest)
        return False


def main() -> None:
    print("=" * 65)
    print("  Raspberry Pi 3B Simulation Boot Files Downloader")
    print("=" * 65)

    os.makedirs(IMG_DIR, exist_ok=True)
    print(f"Image directory: {IMG_DIR}")

    # ── kernel8.img ──────────────────────────────────────────────────────
    if os.path.exists(KERNEL_PATH):
        print(f"\n[OK] kernel8.img already present")
    else:
        if not download_file(KERNEL_URL, KERNEL_PATH):
            print("FATAL: could not download kernel8.img")
            sys.exit(1)
        print("[OK] kernel8.img downloaded")

    # ── DTB ──────────────────────────────────────────────────────────────
    if os.path.exists(DTB_PATH):
        print(f"[OK] bcm271~1.dtb already present")
    else:
        if not download_file(DTB_URL, DTB_PATH):
            print("FATAL: could not download DTB")
            sys.exit(1)
        print("[OK] bcm271~1.dtb downloaded")

    # ── SD image ─────────────────────────────────────────────────────────
    print("\n" + "-" * 65)
    print("  SD Disk Image")
    print("-" * 65)

    if os.path.exists(SD_IMAGE_PATH):
        size_gb = os.path.getsize(SD_IMAGE_PATH) / 1_073_741_824
        print(f"[OK] SD image already present ({size_gb:.2f} GB):\n  {SD_IMAGE_PATH}")
    else:
        # Check if there's already a different .img that the emulator can auto-detect
        existing = [
            f for f in os.listdir(IMG_DIR)
            if f.endswith(".img") and f != "kernel8.img"
        ]
        if existing:
            print(f"[OK] Alternative SD image found (auto-detect will use it):")
            for f in existing:
                size_gb = os.path.getsize(os.path.join(IMG_DIR, f)) / 1_073_741_824
                print(f"  {f}  ({size_gb:.2f} GB)")
        else:
            print(f"[MISSING] {SD_IMAGE_IMG}")
            print(f"\nDownloading Raspberry Pi OS Lite (armhf) ~500 MB compressed ...")
            print("(This will extract to ~2 GB. Press Ctrl+C to skip.)\n")
            try:
                ok = download_file(SD_IMAGE_URL, SD_XZ_PATH)
                if ok:
                    ok = extract_xz(SD_XZ_PATH, SD_IMAGE_PATH)
                    if ok:
                        print(f"  Removing compressed archive ...")
                        os.remove(SD_XZ_PATH)
                        print(f"[OK] SD image ready: {SD_IMAGE_PATH}")
                    else:
                        print("[FAIL] Extraction failed. See error above.")
                        sys.exit(1)
                else:
                    print("\n[FAIL] Download failed.")
                    print("\nManual alternative:")
                    print(f"  1. Download: {SD_IMAGE_URL}")
                    print(f"  2. Extract the .xz file")
                    print(f"  3. Place the .img in: {IMG_DIR}")
                    print("  (Any *.img file in img/ will be auto-detected by the emulator)")
                    sys.exit(1)
            except KeyboardInterrupt:
                print("\n\nSkipped SD image download.")
                print(f"Place any Raspberry Pi OS armhf .img in:\n  {IMG_DIR}")
                if os.path.exists(SD_XZ_PATH):
                    os.remove(SD_XZ_PATH)

    print("\n" + "=" * 65)
    print("  All boot files ready. You can now start the simulation.")
    print("=" * 65)


if __name__ == "__main__":
    main()
