<?php
/**
 * Glasgow Baha'i theme bootstrap.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'GLASGOW_BAHAI_VERSION', '1.0.0' );

/**
 * Theme setup: supports, menus, image sizes.
 */
function glasgow_bahai_setup() {
	load_theme_textdomain( 'glasgow-bahai', get_template_directory() . '/languages' );

	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'custom-logo', array(
		'height'      => 60,
		'width'       => 240,
		'flex-height' => true,
		'flex-width'  => true,
	) );
	add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script' ) );
	add_theme_support( 'responsive-embeds' );
	add_theme_support( 'automatic-feed-links' );

	register_nav_menus( array(
		'primary' => __( 'Primary Menu', 'glasgow-bahai' ),
		'footer'  => __( 'Footer Menu', 'glasgow-bahai' ),
	) );

	add_image_size( 'glasgow-bahai-card', 480, 360, true );
}
add_action( 'after_setup_theme', 'glasgow_bahai_setup' );

/**
 * Enqueue styles and scripts.
 */
function glasgow_bahai_scripts() {
	wp_enqueue_style( 'glasgow-bahai-fonts', 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Source+Sans+3:wght@400;600&display=swap', array(), null );
	wp_enqueue_style( 'glasgow-bahai-style', get_stylesheet_uri(), array(), GLASGOW_BAHAI_VERSION );
	wp_enqueue_script( 'glasgow-bahai-main', get_template_directory_uri() . '/assets/js/main.js', array(), GLASGOW_BAHAI_VERSION, true );

	if ( is_singular() && comments_open() ) {
		wp_enqueue_script( 'comment-reply' );
	}
}
add_action( 'wp_enqueue_scripts', 'glasgow_bahai_scripts' );

/**
 * Register widget/sidebar areas.
 */
function glasgow_bahai_widgets_init() {
	register_sidebar( array(
		'name'          => __( 'Sidebar', 'glasgow-bahai' ),
		'id'            => 'sidebar-1',
		'before_widget' => '<div class="widget">',
		'after_widget'  => '</div>',
		'before_title'  => '<h3>',
		'after_title'   => '</h3>',
	) );
}
add_action( 'widgets_init', 'glasgow_bahai_widgets_init' );

/**
 * Fallback menu for the primary nav when no menu is assigned yet.
 */
function glasgow_bahai_fallback_menu() {
	echo '<ul id="primary-menu" class="menu">';
	wp_list_pages( array(
		'title_li' => '',
		'depth'    => 1,
	) );
	echo '</ul>';
}

require get_template_directory() . '/inc/template-tags.php';
