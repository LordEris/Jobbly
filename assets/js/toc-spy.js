// toc-spy.js — gabarit commun des politiques de confidentialité Lorderis
// (Account-LordEris, reference/privacy/). Recopié TEL QUEL dans chaque site :
// une correction se fait là-bas d'abord, puis se reporte.
//
// Surligne dans le sommaire (.toc) la section lue du corps (.legal-body) en
// lui posant la classe .on.
// 1. Fichier externe, jamais un <script> en ligne : la CSP des sites n'a que
//    script-src 'self'.
// 2. Une section masquée (l'autre langue d'une page qui porte les deux) ne
//    croise jamais la fenêtre, et ne surligne donc rien.
// 3. Sans IntersectionObserver, ou sans section, le sommaire reste une liste
//    de liens qui fonctionne.
(function () {
  'use strict';

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length) return;

  var map = {};
  links.forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') map[href.slice(1)] = a;
  });

  var sections = Array.prototype.slice.call(document.querySelectorAll('.legal-body section'));
  if (!('IntersectionObserver' in window) || !sections.length) return;

  // Une section devient active quand son corps traverse le tiers supérieur de
  // la fenêtre (entre 30 % et 40 % du haut), pas quand son titre entre.
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var on = map[entry.target.id];
      if (!on) return;
      links.forEach(function (l) { l.classList.remove('on'); });
      on.classList.add('on');
    });
  }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });

  sections.forEach(function (s) { io.observe(s); });
})();
