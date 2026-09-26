/**
 * 没配立绘的卡用的内置基础表情:{{sprites}} 展开成它们,立绘标签也拿它们当候选。
 * 和后端 AnimaBackend/app/tts/emotion_presets.py 的 PRESETS 是同一张表(每组第一个是名字,
 * 其余是别名),IndexTTS 的默认向量正好覆盖每一项。改这里要一起改那边(后端有测试对照这个文件)
 */
export const BUILTIN_EMOTIONS: readonly { label: string; aliases: readonly string[] }[] = [
  { label: '平静', aliases: ['normal', 'calm', 'neutral', '说话', 'talk', '默认'] },
  { label: '微笑', aliases: ['smile'] },
  { label: '开心', aliases: ['高兴', 'happy'] },
  { label: '温柔', aliases: ['gentle'] },
  { label: '认真', aliases: ['serious'] },
  { label: '担心', aliases: ['worried'] },
  { label: '难过', aliases: ['伤心', 'sad'] },
  { label: '哭', aliases: ['cry'] },
  { label: '惊讶', aliases: ['surprised'] },
  { label: '慌张', aliases: ['flustered'] },
  { label: '害羞', aliases: ['脸红', 'shy'] },
  { label: '疑惑', aliases: ['confused'] },
  { label: '生气', aliases: ['angry'] },
  { label: '害怕', aliases: ['afraid', 'scared'] },
  { label: '厌恶', aliases: ['嫌弃', 'disgusted'] },
  { label: '忧郁', aliases: ['失落', 'melancholic'] },
];
