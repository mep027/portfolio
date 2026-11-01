   let pages = [
     { url: '', title: 'Home' },
     { url: 'projects/', title: 'Projects' },
     { url: 'contact/', title: 'Contact' },
     { url: 'resume/', title: 'Resume' },
     { url: 'https://github.com/mep027', title: 'GitHub' },
   ];

   const BASE_PATH =
     location.hostname === 'localhost' || location.hostname === '127.0.0.1'
       ? '/'
       : '/portfolio/';

   let nav = document.createElement('nav');
   document.body.prepend(nav);

   for (let p of pages) {
     let url = !p.url.startsWith('http') ? BASE_PATH + p.url : p.url;
     let a = document.createElement('a');
     a.href = url;
     a.textContent = p.title;
     a.classList.toggle('current',
       a.host === location.host && a.pathname === location.pathname);
     if (a.host !== location.host) a.target = '_blank';
     nav.append(a);
   }



      document.body.insertAdjacentHTML('afterbegin', `
     <label class="color-scheme">
       Theme:
       <select>
         <option value="light dark">Automatic</option>
         <option value="light">Light</option>
         <option value="dark">Dark</option>
       </select>
     </label>`);

   let select = document.querySelector('.color-scheme select');

   function setColorScheme(scheme) {
     document.documentElement.style.setProperty('color-scheme', scheme);
     select.value = scheme;
   }

   if ('colorScheme' in localStorage) setColorScheme(localStorage.colorScheme);

   select.addEventListener('input', (event) => {
     setColorScheme(event.target.value);
     localStorage.colorScheme = event.target.value;
   });

     export async function fetchJSON(url) {
     try {
       const response = await fetch(url);
       if (!response.ok) {
         throw new Error(`Failed to fetch projects: ${response.statusText}`);
       }
       return await response.json();
     } catch (error) {
       console.error('Error fetching or parsing JSON data:', error);
     }
   }

   export function renderProjects(projects, containerElement, headingLevel = 'h2') {
  containerElement.innerHTML = '';
  for (let project of projects) {
    const article = document.createElement('article');
    article.innerHTML = `
      <${headingLevel}>${project.title}</${headingLevel}>
      <img src="${project.image}" alt="${project.title}">
      <div>
        <p>${project.description}</p>
        <p class="project-year">c. ${project.year}</p>
      </div>
    `;
    containerElement.appendChild(article);
  }
}

  export async function fetchGitHubData(username) {
  return fetchJSON(`https://api.github.com/users/${username}`);
}



 
