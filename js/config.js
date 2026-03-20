// p-book for Kids — How Recommendations Work

export const CONFIG = {
  book: {
    title: 'How Recommendations Work',
    author: 'Pavel Kordik',
    contentDir: 'content',
    bookIndex: 'content/book.json'
  },

  recombee: {
    enabled: true,
    database: 'cvachond-land-free-pbook-kids',
    scenarios: {
      nextInSpine: 'pbook:next-in-spine',
      goDeeper: 'pbook:go-deeper',
      related: 'pbook:related',
      forYou: 'pbook:for-you',
      popular: 'pbook:popular',
      startHere: 'pbook:start-here'
    }
  },

  features: {
    socialPreview: false,
    diagrams: true,
    keyboardNav: true,
    progressTracking: true,
    recommendations: true
  },

  // Voices adapted for kids (8-15 years old)
  voices: {
    explorer: { label: 'Explorer', icon: '\u{1F50D}', description: 'How does it work? Show me!' },
    creator: { label: 'Creator', icon: '\u{1F3A8}', description: 'I want to build something!' },
    thinker: { label: 'Thinker', icon: '\u{1F9E0}', description: 'Why does it work that way?' }
  }
};
