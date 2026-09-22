/* Export the actual desktop KAI art for native Android ImageViews.
 * No tracing, replacement geometry, generated artwork, or runtime web content.
 * Uses the repository's pinned sharp dependency and its static SVG renderer.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

(async () => {
    const repo = path.resolve(__dirname, '../..');
    const sourceFiles = ['ui/kai-robot.svg', 'ui/kai-character.css', 'ui/assets/kai-character.png'];
    const [svgBytes, cssBytes, texture] = await Promise.all(sourceFiles.map(name => fs.readFile(path.join(repo, name))));
    // Keep the original masks, texture, face, silhouette and default idle styles.
    // Static SVG rendering does not run CSS animation or select activity states.
    const svg = svgBytes.toString().replaceAll('href="assets/kai-character.png"', `href="data:image/png;base64,${texture.toString('base64')}"`);
    const output = path.join(repo, 'android/app/src/main/res/drawable-nodpi');
    await fs.mkdir(output, { recursive: true });
    for (const art of [
        { name: 'kai_mascot', width: 512, height: 720, viewBox: '0 40 1024 1440' },
        // Same avatar viewport used in ui/brand.js.
        { name: 'kai_avatar', width: 492, height: 330, viewBox: '20 60 984 660' },
    ]) {
        const document = svg.replace('viewBox="0 40 1024 1440"', `width="${art.width}" height="${art.height}" viewBox="${art.viewBox}"`)
            .replace('<defs>', `<style>${cssBytes.toString()}</style><defs>`);
        await sharp(Buffer.from(document)).resize(art.width, art.height).png().toFile(path.join(output, `${art.name}.png`));
    }
    const sources = sourceFiles.map((file, i) => ({ file, sha256: crypto.createHash('sha256').update([svgBytes, cssBytes, texture][i]).digest('hex') }));
    await fs.writeFile(path.join(repo, 'android/mascot-source.json'), JSON.stringify({ description: 'Original desktop KAI rig rendered in its static idle pose. Avatar viewport matches ui/brand.js. Launcher icon is separate.', renderer: { sharp: sharp.versions.sharp, librsvg: sharp.versions.rsvg }, sources }, null, 2) + '\n');
    console.log('Exported the original KAI mascot and avatar for Android.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
