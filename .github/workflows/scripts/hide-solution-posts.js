hexo.extend.filter.register('before_generate', function () {
  const posts = hexo.locals.get('posts');

  posts.forEach(function (post) {
    const isSolution = post.categories &&
      post.categories.some(function (category) {
        return category.name === '题解';
      });

    // 题解默认不进入主页，除非文章明确开启
    if (isSolution && post.show_on_home !== true) {
      post.hidden = true;
    }
  });
});
