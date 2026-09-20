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

	// Block editor parity: keep Gutenberg's canvas honest about what the front end looks like.
	add_theme_support( 'editor-styles' );
	add_theme_support( 'align-wide' );
	add_theme_support( 'wp-block-styles' );
	add_theme_support( 'custom-line-height' );
	add_theme_support( 'custom-spacing' );

	// Lets the client set a homepage hero photo from Appearance > Customize > Header Image.
	add_theme_support( 'custom-header', array(
		'width'       => 1600,
		'height'      => 900,
		'flex-height' => true,
		'flex-width'  => true,
	) );

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
 * Preconnect to the Google Fonts origins used by the theme, ahead of the stylesheet request.
 */
function glasgow_bahai_resource_hints( $urls, $relation_type ) {
	if ( 'preconnect' === $relation_type ) {
		$urls[] = array( 'href' => 'https://fonts.googleapis.com' );
		$urls[] = array(
			'href'        => 'https://fonts.gstatic.com',
			'crossorigin' => '',
		);
	}
	return $urls;
}
add_filter( 'wp_resource_hints', 'glasgow_bahai_resource_hints', 10, 2 );

/**
 * Block editor canvas styling, inlined so it works without a physical theme file
 * (this theme is updated via the built-in Theme File Editor, which can't add new files).
 */
function glasgow_bahai_block_editor_styles() {
	wp_enqueue_style( 'glasgow-bahai-editor-fonts', 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Source+Sans+3:wght@400;600&display=swap', array(), null );
	wp_register_style( 'glasgow-bahai-editor-style', false, array(), GLASGOW_BAHAI_VERSION );
	wp_enqueue_style( 'glasgow-bahai-editor-style' );

	$css = "
		.editor-styles-wrapper {
			font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
			color: #1c2b39;
			background: #faf7f1;
			font-size: 18px;
			line-height: 1.7;
		}
		.editor-styles-wrapper h1, .editor-styles-wrapper h2, .editor-styles-wrapper h3, .editor-styles-wrapper h4 {
			font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
			font-weight: 600;
			color: #12283f;
			line-height: 1.25;
		}
		.editor-styles-wrapper a { color: #1b3a5c; }
		.editor-styles-wrapper blockquote {
			border-left: 3px solid #b4903e;
			padding-left: 24px;
			font-family: 'Cormorant Garamond', Georgia, serif;
			font-style: italic;
			font-size: 1.2rem;
			color: #12283f;
		}
		.editor-styles-wrapper .wp-block-button__link {
			background: #1b3a5c;
			border-radius: 4px;
			text-transform: uppercase;
			font-size: 0.9rem;
			letter-spacing: 0.04em;
		}
	";
	wp_add_inline_style( 'glasgow-bahai-editor-style', $css );
}
add_action( 'enqueue_block_editor_assets', 'glasgow_bahai_block_editor_styles' );

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

/**
 * Marks the active nav link for assistive tech, matching WordPress's own current-menu-item class.
 */
function glasgow_bahai_nav_menu_link_attributes( $atts, $item ) {
	if ( in_array( 'current-menu-item', $item->classes, true ) ) {
		$atts['aria-current'] = 'page';
	}
	return $atts;
}
add_filter( 'nav_menu_link_attributes', 'glasgow_bahai_nav_menu_link_attributes', 10, 2 );

/**
 * Shorter, theme-styled excerpts.
 */
function glasgow_bahai_excerpt_length( $length ) {
	return 24;
}
add_filter( 'excerpt_length', 'glasgow_bahai_excerpt_length' );

function glasgow_bahai_excerpt_more( $more ) {
	return '&hellip;';
}
add_filter( 'excerpt_more', 'glasgow_bahai_excerpt_more' );

/**
 * Basic SEO + social preview tags. Skipped if an SEO plugin (which does this better) is active.
 */
function glasgow_bahai_meta_tags() {
	if ( defined( 'WPSEO_VERSION' ) || class_exists( 'Classic_SEO' ) || function_exists( 'rank_math' ) ) {
		return;
	}

	$description = '';
	if ( is_singular() ) {
		global $post;
		$description = has_excerpt( $post ) ? get_the_excerpt( $post ) : wp_trim_words( wp_strip_all_tags( $post->post_content ), 30 );
	} else {
		$description = get_bloginfo( 'description' );
	}
	$description = wp_strip_all_tags( $description );

	$title = is_singular() ? get_the_title() : get_bloginfo( 'name' );
	$image = '';
	if ( is_singular() && has_post_thumbnail() ) {
		$image = get_the_post_thumbnail_url( null, 'large' );
	} elseif ( has_header_image() ) {
		$image = get_header_image();
	}

	echo "\n<!-- Glasgow Baha'i theme: basic SEO tags -->\n";
	if ( $description ) {
		printf( '<meta name="description" content="%s">' . "\n", esc_attr( $description ) );
	}
	printf( '<meta property="og:type" content="%s">' . "\n", is_singular() ? 'article' : 'website' );
	printf( '<meta property="og:title" content="%s">' . "\n", esc_attr( $title ) );
	if ( $description ) {
		printf( '<meta property="og:description" content="%s">' . "\n", esc_attr( $description ) );
	}
	printf( '<meta property="og:url" content="%s">' . "\n", esc_url( is_singular() ? get_permalink() : home_url( '/' ) ) );
	if ( $image ) {
		printf( '<meta property="og:image" content="%s">' . "\n", esc_url( $image ) );
	}
	printf( '<meta name="twitter:card" content="%s">' . "\n", $image ? 'summary_large_image' : 'summary' );
}
add_action( 'wp_head', 'glasgow_bahai_meta_tags', 1 );

/**
 * Organization structured data so search engines understand this is a community, not a blog.
 */
function glasgow_bahai_structured_data() {
	if ( ! is_front_page() ) {
		return;
	}
	$data = array(
		'@context' => 'https://schema.org',
		'@type'    => 'Organization',
		'name'     => get_bloginfo( 'name' ),
		'url'      => home_url( '/' ),
	);
	if ( has_custom_logo() ) {
		$logo_id  = get_theme_mod( 'custom_logo' );
		$logo_src = $logo_id ? wp_get_attachment_image_url( $logo_id, 'full' ) : '';
		if ( $logo_src ) {
			$data['logo'] = $logo_src;
		}
	}
	echo '<script type="application/ld+json">' . wp_json_encode( $data ) . '</script>' . "\n";
}
add_action( 'wp_head', 'glasgow_bahai_structured_data' );

/**
 * Contact page form handler (see page-contact.php). Sends via wp_mail, no plugin required.
 */
function glasgow_bahai_handle_contact_form() {
	if ( ! isset( $_POST['glasgow_bahai_contact_nonce'] ) || ! wp_verify_nonce( $_POST['glasgow_bahai_contact_nonce'], 'glasgow_bahai_contact' ) ) {
		wp_safe_redirect( add_query_arg( 'contact', 'error', wp_get_referer() ?: home_url( '/contact/' ) ) );
		exit;
	}

	// Honeypot: real visitors never fill this hidden field in.
	if ( ! empty( $_POST['glasgow_bahai_contact_website'] ) ) {
		wp_safe_redirect( add_query_arg( 'contact', 'success', wp_get_referer() ?: home_url( '/contact/' ) ) );
		exit;
	}

	$name    = isset( $_POST['contact_name'] ) ? sanitize_text_field( wp_unslash( $_POST['contact_name'] ) ) : '';
	$email   = isset( $_POST['contact_email'] ) ? sanitize_email( wp_unslash( $_POST['contact_email'] ) ) : '';
	$message = isset( $_POST['contact_message'] ) ? sanitize_textarea_field( wp_unslash( $_POST['contact_message'] ) ) : '';

	$redirect_to = wp_get_referer() ?: home_url( '/contact/' );

	if ( ! $name || ! is_email( $email ) || ! $message ) {
		wp_safe_redirect( add_query_arg( 'contact', 'error', $redirect_to ) );
		exit;
	}

	$to      = get_option( 'admin_email' );
	$subject = sprintf( '[%s] New contact form message from %s', get_bloginfo( 'name' ), $name );
	$body    = "Name: {$name}\nEmail: {$email}\n\nMessage:\n{$message}";
	$headers = array( 'Reply-To: ' . $name . ' <' . $email . '>' );

	$sent = wp_mail( $to, $subject, $body, $headers );

	wp_safe_redirect( add_query_arg( 'contact', $sent ? 'success' : 'error', $redirect_to ) );
	exit;
}
add_action( 'admin_post_glasgow_bahai_contact', 'glasgow_bahai_handle_contact_form' );
add_action( 'admin_post_nopriv_glasgow_bahai_contact', 'glasgow_bahai_handle_contact_form' );

require get_template_directory() . '/inc/template-tags.php';
