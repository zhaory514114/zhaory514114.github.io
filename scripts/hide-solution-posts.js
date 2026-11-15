'use strict';

const pagination = require('hexo-pagination');

// 替换默认主页生成器：只过滤主页，不影响分类页、归档页和文章链接。
hexo.extend.generator.unregister('index');
hexo.extend.generator.register('index', function (locals) {
  const config = this.config;
  const posts = locals.posts.filter(function (post) {
    const categories = post.categories && post.categories.toArray
      ? post.categories.toArray()
      : Array.from(post.categories || []);
    const isSolution = categories.some(function (category) {
      return category.name === '题解';
    });

    return !isSolution || post.show_on_home === true;
  }).sort(config.index_generator.order_by);

  posts.data.sort(function (a, b) {
    return (b.sticky || 0) - (a.sticky || 0);
  });

  const paginationDir = config.index_generator.pagination_dir || config.pagination_dir || 'page';
  const path = config.index_generator.path || '';

  return pagination(path, posts, {
    perPage: config.index_generator.per_page,
    layout: config.index_generator.layout || ['index', 'archive'],
    format: paginationDir + '/%d/',
    data: { __index: true }
  });
});
