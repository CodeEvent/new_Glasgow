<?php
/**
 * The template for displaying 404 pages (not found).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
?>

<section class="section" style="text-align:center;">
	<div class="container">
		<h1><?php esc_html_e( 'Page not found', 'glasgow-bahai' ); ?></h1>
		<p><?php esc_html_e( 'The page you were looking for could not be found. It may have moved, or the address may be incorrect.', 'glasgow-bahai' ); ?></p>
		<div class="error-404-search">
			<?php get_search_form(); ?>
		</div>
		<a class="btn btn-solid" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php esc_html_e( 'Return home', 'glasgow-bahai' ); ?></a>
	</div>
</section>

<?php get_footer(); ?>
