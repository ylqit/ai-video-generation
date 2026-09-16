import { config } from '../src/server/config.js';
import { runProcess } from '../src/server/media.js';
import { codexExecutable } from '../src/server/codex.js';
import { ComfyClient, compileH3 } from '../src/server/comfy.js';
import { guidedTemplateVersion } from '../src/server/h3-guided.js';
console.log('Node ' + process.version);
console.log('数据目录：' + config.dataDir);
let failures = 0;
for (const [command, args] of [
  [config.ffmpeg, ['-version']],
  [config.ffprobe, ['-version']],
  [codexExecutable(), ['--version']],
] as [string, string[]][]) {
  try {
    const result = await runProcess(command, args);
    console.log(result.split('\n')[0]);
  } catch (e: any) {
    failures++;
    console.error(e.message);
  }
}
if (process.argv.includes('--cloud')) {
  try {
    const client = new ComfyClient(config.comfyUrl),
      d = await client.discover();
    console.log(
      JSON.stringify(
        {
          checkedAt: d.checkedAt,
          system: d.stats.system.comfyui_version,
          devices: d.stats.devices.map((v: any) => v.name),
          models: d.models,
          capabilities: d.capabilities,
          queue: d.queue,
        },
        null,
        2,
      ),
    );
    for (const mode of ['t2v', 'ref2va']) {
      await client.validate(
        compileH3(
          {
            segment: { mode, prompt: 'Read-only schema validation', duration: 5, references: [] },
            assets: [],
            width: 864,
            height: 480,
            steps: 20,
            seed: 1,
          },
          new Map(),
          'schema-check',
        ),
      );
      console.log(mode + '：节点与模型契约检查通过；未提交。');
    }
    const reference = { assetId: 'schema-image', revision: 1, role: 'identity' };
    await client.validate(
      compileH3(
        {
          templateVersion: guidedTemplateVersion,
          segment: {
            mode: 'ref2va',
            prompt: 'Read-only schema validation',
            duration: 5,
            references: [reference],
            guides: [{ ...reference, frameIndex: 0 }],
            guidedPrompt: {
              summary: 'Read-only capability check.',
              detailedDescription: '[Shot 1] <Subject 1> remains still.',
              overallSoundscape: 'N/A',
              nonDiegeticMusic: 'N/A',
            },
          },
          assets: [
            {
              reference,
              asset: {
                data: {
                  adopted: true,
                  mediaType: 'image',
                  width: 864,
                  height: 480,
                  name: 'Schema placeholder',
                  sha256: 'schema-placeholder',
                },
              },
            },
          ],
          width: 864,
          height: 480,
          steps: 20,
          seed: 1,
        },
        new Map([['schema-image:1', 'schema-placeholder.png']]),
        'schema-check',
      ),
    );
    console.log('Ref2VA + Add Guide：真实输入输出与模型契约检查通过；未上传、未提交。');
  } catch (e: any) {
    failures++;
    console.error(e.message);
  }
}
process.exitCode = failures ? 1 : 0;
