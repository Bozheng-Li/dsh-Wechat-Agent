export const MiB = 1024 * 1024;

export const MEDIA_LIBRARY_LIMITS = Object.freeze({
  uploadBytes: 32 * MiB,
  imageBytes: 10 * MiB,
  expandedBytes: 64 * MiB,
  imagesPerImport: 300,
  zipEntries: 1000,
  accountBytes: 512 * MiB,
  accountAssets: 2000,
  chunkBytes: 256 * 1024,
});

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/i;

export const UNSAFE_EXTENSIONS =
  /\.(?:exe|com|dll|scr|msi|msp|bat|cmd|ps1|vbs|vbe|js|jse|mjs|cjs|hta|html?|svg|sh|py|jar|lnk|url|reg|app|dmg)$/i;
