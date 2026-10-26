# Web security glossary

## Hashing
Hashing turns data into a fixed-length value that is designed to be difficult to reverse. Websites use password hashes to check a login without storing the original password.
Example: A site hashes the password you enter and compares it with the saved hash.

## Salting
A salt is random data added to a password before it is hashed. A unique salt makes identical passwords produce different hashes, which makes stolen password lists harder to crack in bulk.
Example: Two accounts with the same password get different stored hashes because each password has its own salt.

## CSRF
Cross-site request forgery (CSRF) tricks your browser into sending an unwanted request to a site where you are already signed in. Because the browser sends your login cookie automatically, the site may treat the request as if you made it on purpose.
Example: A malicious page secretly submits a form to your bank that transfers money, and the bank accepts it because you are logged in.

## XSS
Cross-site scripting (XSS) happens when a site shows attacker-supplied content without cleaning it, so the attacker's script runs in other visitors' browsers. That script can then read data from the page or act as the visitor.
Example: A comment containing a hidden script steals the session cookie of everyone who views the comment.

## CORS
Cross-origin resource sharing (CORS) is a set of rules a server uses to tell browsers which other websites may read its responses. By default, browsers block a page from reading data from a different site, and CORS lets the server relax that rule for trusted sites.
Example: An API at api.example.com allows app.example.com to fetch its data but not unknown sites.

## Rate limiting
Rate limiting caps how many requests a user or device can make in a set amount of time. It slows down password-guessing attacks and stops one client from overloading a service.
Example: A login page allows five failed attempts per minute, then makes you wait before trying again.




