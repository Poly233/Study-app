// 英検準1級 英作文の練習問題（すべてオリジナル）。
// 要約：約200語の文章を 60〜70 語に要約。意見論述：TOPIC について POINTS から2つ使って 120〜150 語。

export const WRITING_RULES = {
  summary: {
    label: '要約',
    min: 60,
    max: 70,
    minutes: 15,
    instruction: 'Read the article below and summarize it in your own words as far as possible in English. Your summary should be between 60 and 70 words.',
  },
  opinion: {
    label: '意見論述',
    min: 120,
    max: 150,
    minutes: 20,
    instruction: 'Write an essay on the given TOPIC. Use TWO of the POINTS below to support your answer. Structure: introduction, main body, and conclusion. Suggested length: 120–150 words.',
  },
};

export const WRITING_TASKS = [
  {
    id: 'sum-4day-week', type: 'summary', title: 'Four-day work week',
    passage: `In recent years, a growing number of companies around the world have been experimenting with a four-day work week. Under this system, employees work four days instead of five, usually without any reduction in their salary. Some governments have also shown interest in the idea and have supported trial programs.

Supporters say the shorter week has clear benefits. Many workers report feeling less stressed and more motivated, and some firms have found that productivity stays the same or even increases. In addition, companies that offer a four-day week often find it easier to attract and keep skilled staff, which is a major advantage at a time when many industries are facing labor shortages.

However, the system does not suit every type of business. Hospitals, stores, and other services that must operate every day may need to hire extra workers to cover the missing day, which raises costs. Critics also point out that some employees end up working longer hours on the remaining four days, which can cause fatigue. For these reasons, experts suggest that companies should carefully consider whether the system fits their situation before introducing it.`,
  },
  {
    id: 'sum-vertical-farming', type: 'summary', title: 'Vertical farming',
    passage: `Vertical farming is a method of growing crops in stacked layers inside buildings rather than in open fields. The plants are grown under LED lights, and computers control the temperature, humidity, and amount of water they receive. This type of farming has been attracting attention in cities where farmland is limited.

One reason for its popularity is that it allows food to be produced close to the people who eat it. Because the farms are located in or near cities, transportation costs and the amount of fuel used to deliver food can be reduced. Moreover, since the crops are grown indoors, they are not affected by bad weather or insects, so farmers can harvest them throughout the year without using pesticides.

On the other hand, vertical farms require large amounts of electricity for lighting and air conditioning, which makes their operating costs high. As a result, the vegetables they produce are often more expensive than those grown in fields. In addition, at present only certain crops, such as lettuce and herbs, can be grown profitably in this way. Some companies are now trying to lower energy costs by using renewable energy sources.`,
  },
  {
    id: 'sum-cashless', type: 'summary', title: 'Cashless payments in Japan',
    passage: `Japan has long been known as a country where people prefer to pay with cash. In recent years, however, the use of cashless payment methods, such as credit cards and smartphone apps, has been increasing rapidly. The government has encouraged this trend by offering reward points to consumers who pay without cash.

There are several reasons why businesses welcome this change. Cashless payments allow stores to serve customers more quickly, and they reduce the time employees spend counting money at the end of the day. Moreover, as the number of foreign tourists visiting Japan grows, stores that accept card and smartphone payments can attract more visitors who do not carry Japanese currency.

Nevertheless, some people remain cautious. Elderly people in particular often find new payment apps difficult to use, and some worry that their personal information could be stolen. Small shops also complain that the fees charged by payment companies reduce their already limited profits. Some experts argue that, in order for cashless payments to spread further, these fees should be lowered and more support should be provided for people who are not familiar with digital technology.`,
  },
  {
    id: 'sum-bike-sharing', type: 'summary', title: 'Bike-sharing services',
    passage: `Bike-sharing services, which allow people to rent bicycles from stations located around a city and return them to any other station, have become common in many urban areas. Users can usually unlock a bicycle with a smartphone app and pay only for the time they use it.

Local governments have supported these services for several reasons. Bicycles do not produce greenhouse gases, so replacing short car trips with bicycle rides can help reduce air pollution and traffic congestion. Furthermore, the services are convenient for tourists, who can easily visit sightseeing spots that are not near train stations, and cycling also gives people a chance to get some exercise in their daily lives.

However, bike-sharing has also created some problems. In some cities, users have left bicycles on sidewalks instead of returning them to stations, making it difficult for pedestrians to walk safely. There are also concerns about accidents, since some users are not familiar with traffic rules for bicycles. To deal with these issues, some cities have introduced stricter parking rules and are providing safety lessons for riders.`,
  },
  {
    id: 'op-foreign-workers', type: 'opinion', title: 'Foreign workers',
    topic: 'Agree or disagree: Japan should accept more foreign workers',
    points: ['Labor shortages', 'Cultural diversity', 'Language barriers', 'The economy'],
  },
  {
    id: 'op-remote-work', type: 'opinion', title: 'Working from home',
    topic: 'Should companies allow their employees to work from home more often?',
    points: ['Productivity', 'Work-life balance', 'Communication', 'Costs'],
  },
  {
    id: 'op-plastic', type: 'opinion', title: 'Plastic waste',
    topic: 'Is enough being done to reduce plastic waste?',
    points: ['Business responsibility', 'Consumer habits', 'Government regulations', 'Recycling'],
  },
  {
    id: 'op-ai-education', type: 'opinion', title: 'AI in education',
    topic: 'Will artificial intelligence have a positive effect on education?',
    points: ['Personalized learning', 'Cheating', "Teachers' workload", 'Critical thinking'],
  },
  {
    id: 'op-rural', type: 'opinion', title: 'Rural areas',
    topic: 'Should the government do more to support people living in rural areas?',
    points: ['Transportation', 'Medical care', 'Population decline', 'Tourism'],
  },
  {
    id: 'op-voting', type: 'opinion', title: 'Compulsory voting',
    topic: 'Agree or disagree: Voting in national elections should be compulsory',
    points: ['Democracy', 'Freedom of choice', 'Young people', 'Political awareness'],
  },
];

export function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
}
