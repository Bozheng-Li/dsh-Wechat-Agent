export function personaText(persona = {}) {
  if (typeof persona.prompt === 'string') return persona.prompt;
  return [
    persona.background && `角色背景：\n${persona.background}`,
    persona.personality && `性格与互动：\n${persona.personality}`,
    persona.style && `表达方式：\n${persona.style}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
