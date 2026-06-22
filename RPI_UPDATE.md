I'll help you find information about changes related to QEMU and Raspberry Pi 3B emulator in the last 1-2 months. Let me search the repository's commit history.Now let me search for commits specifically related to QEMU and Raspberry Pi:Now let me search for more specific commit information about recent QEMU and Pi emulation changes:Now let me get more detailed information about the specific key commits:Based on my investigation of the Velxio repository, here's a comprehensive summary of the major QEMU and Raspberry Pi 3B emulator changes made in the last 1-2 months:

## Major QEMU and Raspberry Pi 3B Emulation Changes

### **1. Critical Machine Type Migration: raspi3b → virt (May 2026)**

The most significant change was **switching from the `raspi3b` QEMU machine type to the generic `virt` machine type**. This was driven by a critical bug discovered in QEMU 10 + Linux kernel 6.12:

**Problem identified:**
- The PL011 UART RX functionality was broken in QEMU 10 with kernel 6.12 on the `raspi3b` machine type
- This caused the serial console to become unresponsive after ~9 seconds during boot
- Full debugging trail documented in `project/pi-emulation/decisions.md`

**Solution implemented (Phase 1):**
- Migrated to `-M virt` + `cortex-a53` CPU for Raspberry Pi 3
- Replaced BCM2837-specific boot with generic ARM64 virtual machine boot
- Switched from `-serial` based UART to virtio-based console architecture
- Implemented **virtio-console over TCP sockets** instead of UART-based serial

### **2. Boot Architecture Overhaul**

| Aspect | Old (raspi3b) | New (virt) |
|--------|-------------|----------|
| **Machine** | `-M raspi3b` | `-M virt` |
| **Console** | ttyAMA0 (UART) | /dev/hvc0 (virtio-console) |
| **Serial Transport** | TCP to UART | TCP to virtio-serial-pci + virtconsole |
| **Block Device** | SD image via `-drive if=sd` | virtio-blk-pci via qcow2 overlay |
| **Boot Files** | kernel8.img + bcm2710-rpi-3-b.dtb + SD image | velxio-kernel-arm64 + velxio-initramfs-arm64.cpio.gz + ext4 rootfs |

### **3. Systemd Removal and Custom Init (April 2026)**

**Problem:** 
- Raspberry Pi OS systemd boot took 2-3 minutes inside QEMU emulation
- Multiple network-wait services caused excessive delays

**Solution:**
- Replaced systemd with a **custom 30-line bash init script** (`/usr/local/sbin/velxio-init`)
- Eliminated systemd dependency graph traversal
- Reduced boot time from **2-3 minutes → ~10 seconds**
- Script simply mounts pseudo-filesystems and respawns bash on loop

### **4. New Boot Image Set: raspberry-pi-3-virt**

Introduced a completely new image set replacing the old `raspberry-pi-3`:

```
'raspberry-pi-3-virt': {
    'qemu': 'qemu-system-aarch64',
    'cpu': 'cortex-a53',
    'smp': '4',
    'memory': '1G',
    'image_set': 'raspberry-pi-3-virt',
    'kernel': 'velxio-kernel-arm64',
    'initramfs': 'velxio-initramfs-arm64.cpio.gz',
    'rootfs': 'velxio-pi-rootfs-arm64.ext4',
    'bus': 'pci',
}
```

### **5. Virtio Transport Layer**

- **Virtio-console (TCP)** for user shell at `/dev/hvc0`
- **Virtio-serial-pci** for protocol multiplexing
- **Virtio-blk-pci** for block storage (unlike the old if=sd SDHCI)
- Device suffixes vary by bus architecture:
  - arm64 virt: `-pci` variants (PCI works)
  - armhf virt: `-device` variants (PCI broken, uses MMIO fallback)

### **6. Protocol Channel Redesign**

Replaced TCP-based serial protocol with **FIFO pipe pairs** for better reliability:

```
Old: -serial tcp:...  (GPIO protocol over TCP socket)
New: -chardev pipe,id=proto,path=/tmp/velxio-pi-proto-*.{in,out}
     -device virtserialport,chardev=proto,name=velxio-protocol
```

**Reason:** QEMU 10's virtserialport on socket chardev had a guest→host flow bug (data silently dropped). Pipes sidestep this issue.

### **7. Support for Pi 4/5 and Preparation for Pi Zero/1/2**

Extended the architecture to support:
- **Pi 4**: Cortex-A72, 2GB RAM, same arm64 image set
- **Pi 5**: Cortex-A76, 2GB RAM, same arm64 image set
- **Phase 3 plan**: Pi Zero/1/2 with separate armhf image set (32-bit ARM)

### **8. QemuManager Refactor**

Major restructuring of `/backend/app/services/qemu_manager.py`:
- Unified PI_CONFIGS dictionary for all Pi board variants
- Per-board CPU, memory, and image-set configuration
- Lazy boot image provider with pre-warming at startup
- Pluggable protocol dispatcher for pro overlay extensions

### **9. Kernel Command-Line Refinement**

New kernel append string:
```bash
-append 'console=hvc0 root=/dev/vda rw quiet panic=10'
```

Removed:
- `earlycon=pl011,mmio32,0x3f201000` (no longer needed for virt)
- `init=/bin/sh` (uses systemd/velxio-init instead)

### **10. Boot File Caching Strategy**

- **BootImageProvider** lazily fetches + caches kernel, initramfs, rootfs
- Named docker volume `/var/cache/velxio/boot-images/raspberry-pi-3-virt/`
- SHA256 verification via sidecar files
- Manifest-driven invalidation when assets change

---

## Impact Summary

| Metric | Before | After | Benefit |
|--------|--------|-------|---------|
| **Boot Time** | 2-3 min | ~10 sec | 10-18x faster |
| **Serial Reliability** | Broken (QEMU 10) | Fixed | Functional on modern QEMU |
| **Machine Type** | raspi3b (real hardware emulation) | virt (generic) | Better upstream compatibility |
| **Supported Pi Models** | Pi 3B only | Pi 3B/4/5 + prep for Pi Zero/1/2 | Board family expansion |
| **Init System** | Systemd | Custom bash script | Eliminates boot bottleneck |

## Repository Links

- **Full commit search**: [https://github.com/davidmonterocrespo24/velxio/search?q=QEMU&type=commits](https://github.com/davidmonterocrespo24/velxio/search?q=QEMU&type=commits)
- **Raspberry Pi commits**: [https://github.com/davidmonterocrespo24/velxio/search?q=Raspberry+Pi&type=commits](https://github.com/davidmonterocrespo24/velxio/search?q=Raspberry+Pi&type=commits)
- **Key documentation**: `docs/RASPBERRYPI3_EMULATION.md` | `backend/app/services/qemu_manager.py`