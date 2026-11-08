export const uiFixtureModels = [
  { id: 'alpha', name: '测试模型 A' },
  {
    id: 'beta', name: '测试模型 B', reasoning: {
      efforts: [
        { id: 'low', name: '低', description: '适合简单问答。' },
        { id: 'high', name: '高', description: '适合较复杂的问题。' },
      ],
      defaultEffort: 'high',
    },
  },
];
