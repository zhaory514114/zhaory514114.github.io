hexo.extend.filter.register('before_generate', function () {
  const posts = hexo.locals.get('posts');

  posts.forEach(function (post) {
    const isSolution = post.categories &&
      post.categories.some(function (category) {
        return category.name === '题解';
      });

    // 必须显式设置 true/false，避免 Hexo 的继承属性被误判。
    post.hidden = Boolean(isSolution && post.show_on_home !== true);
  });
});
