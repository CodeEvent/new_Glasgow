( function () {
	'use strict';

	var toggle = document.querySelector( '.menu-toggle' );
	var nav = document.querySelector( '.main-navigation' );

	if ( ! toggle || ! nav ) {
		return;
	}

	toggle.addEventListener( 'click', function () {
		var isOpen = nav.classList.toggle( 'is-open' );
		toggle.setAttribute( 'aria-expanded', isOpen ? 'true' : 'false' );
	} );
} )();
