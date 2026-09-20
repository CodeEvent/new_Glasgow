<?php
/**
 * The header for this theme.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<div id="page" class="site">
	<a class="screen-reader-text" href="#content"><?php esc_html_e( 'Skip to content', 'glasgow-bahai' ); ?></a>

	<header id="masthead" class="site-header">
		<div class="container site-header__inner">
			<div class="site-branding">
				<?php if ( has_custom_logo() ) :
					the_custom_logo();
				else : ?>
					<?php glasgow_bahai_emblem(); ?>
					<div>
						<p class="site-title">
							<a href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php bloginfo( 'name' ); ?></a>
						</p>
						<?php $description = get_bloginfo( 'description', 'display' ); ?>
						<?php if ( $description ) : ?>
							<span class="site-description"><?php echo esc_html( $description ); ?></span>
						<?php endif; ?>
					</div>
				<?php endif; ?>
			</div>

			<button class="menu-toggle" aria-controls="primary-menu" aria-expanded="false">
				<span class="screen-reader-text"><?php esc_html_e( 'Menu', 'glasgow-bahai' ); ?></span>
				&#9776;
			</button>

			<nav id="site-navigation" class="main-navigation" aria-label="<?php esc_attr_e( 'Primary', 'glasgow-bahai' ); ?>">
				<?php
				wp_nav_menu( array(
					'theme_location' => 'primary',
					'menu_id'        => 'primary-menu',
					'container'      => false,
					'fallback_cb'    => 'glasgow_bahai_fallback_menu',
				) );
				?>
			</nav>
		</div>
	</header>

	<div id="content" class="site-content">
